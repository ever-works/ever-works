import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import {
    createWorkTask,
    fakeSha,
    gotoDashboard,
    readTask,
    seedAppWork,
    seedTaskState,
    seededToken,
    transitionTask,
    type CreatedTask,
    type TaskSeedBody,
} from './helpers/app-works-evolve';

/**
 * APW-08 T29 (plan §9.4) — **delivery chips**: seeded Tasks in each delivery state render the
 * right chip text; the Delivery filter narrows; **Close anyway** confirms.
 *
 * ACC-08-17 (the chain's states as the board reads them), ACC-08-21 (`built` waits for a
 * Deployment), ACC-08-22 (**Close anyway** closes as `closed_without_deploy`; nothing more is
 * opened), and spec §6.1's Delivery filter.
 *
 * ## How the states are reached
 *
 * A merged, built or deployed App Work change needs a git provider, a Build and a Deployment —
 * none of which an in-memory SQLite lane has. So each Task is created through the real
 * `POST /api/tasks` on an App Work seeded by APW-11's fixture route, and only the columns the
 * worker writes (the chain's state, the merged pull request, the deciding Deployment row) are
 * seeded by APW-08 T29's `POST /api/e2e/app-works/task-seed`. Everything the spec ASSERTS is the
 * product's own answer for those rows: `GET /api/tasks?includeDelivery=true` builds each chip's
 * embed (`TaskDeliveryService.listEmbeds`, outcome and live URL read off the Deployment),
 * `?deliveryState=` filters in SQL, `GET /api/tasks/:id/delivery` builds the section, and
 * `POST /api/tasks/:id/delivery/close` moves the Task through the real state machine.
 *
 * Board cards are found by `getByTestId('task-kanban-card')` + `data-task-id`, chips by
 * `getByTestId('task-delivery-chip')` + `data-delivery-state`; chip TEXT is the `en` bundle's
 * `dashboard.tasksPage.delivery.*` copy, asserted verbatim.
 */

interface ChipFixture {
    key: string;
    seed: Omit<TaskSeedBody, 'taskId'>;
    state: string;
    text: string;
    /** The live chip links to the live app on the board. */
    href?: string;
}

const LIVE_URL = 'https://bookings-e2e.apps-e2e.local';

/** One Task per row of spec §6.1's chip table, plus the APW-06 failure outcomes (FR-30). */
function chipFixtures(): ChipFixture[] {
    const carriedMerge = fakeSha();
    return [
        {
            key: 'merged',
            seed: { delivery: { state: 'merged' } },
            state: 'merged',
            text: 'Merged ✓ · Waiting for a build',
        },
        {
            key: 'building',
            seed: { delivery: { state: 'building' } },
            state: 'building',
            text: 'Build ⟳',
        },
        {
            key: 'build_failed',
            seed: { delivery: { state: 'build_failed' } },
            state: 'build_failed',
            text: 'Build failed ✗',
        },
        {
            key: 'built',
            seed: { delivery: { state: 'built' } },
            state: 'built',
            text: 'Built ✓ · Waiting for a deployment',
        },
        {
            key: 'deploying',
            seed: { delivery: { state: 'deploying', deployment: { state: 'BUILDING' } } },
            state: 'deploying',
            text: 'Deploying ⟳',
        },
        {
            key: 'deploy_failed_failed',
            seed: { delivery: { state: 'deploy_failed', deployment: { state: 'ERROR' } } },
            state: 'deploy_failed',
            text: 'Deploy failed ✗ (failed)',
        },
        {
            key: 'deploy_failed_rolled_back',
            seed: { delivery: { state: 'deploy_failed', deployment: { state: 'ROLLED_BACK' } } },
            state: 'deploy_failed',
            text: 'Deploy failed ✗ (rolled back)',
        },
        {
            key: 'deploy_failed_rollback_failed',
            seed: {
                delivery: {
                    state: 'deploy_failed',
                    deployment: { state: 'ERROR', rollbackFailed: true },
                },
            },
            state: 'deploy_failed',
            text: 'Deploy failed ✗ (rollback failed)',
        },
        {
            key: 'live',
            seed: { delivery: { state: 'live', deployment: { state: 'READY', website: LIVE_URL } } },
            state: 'live',
            text: 'Live ✓',
            href: LIVE_URL,
        },
        {
            key: 'live_warnings',
            seed: {
                delivery: {
                    state: 'live',
                    deployment: { state: 'READY', website: LIVE_URL, withWarnings: true },
                },
            },
            state: 'live',
            text: 'Live ✓ (with warnings)',
        },
        {
            key: 'live_carried',
            seed: {
                delivery: {
                    state: 'live',
                    mergeCommitSha: carriedMerge,
                    // The live Deployment carries a LATER commit than this change's merge.
                    deployment: { state: 'READY', website: LIVE_URL, commitSha: fakeSha() },
                },
            },
            state: 'live',
            text: 'Live ✓ (with a later change)',
        },
        {
            key: 'closed',
            seed: { delivery: { state: 'closed_without_deploy' } },
            state: 'closed_without_deploy',
            text: 'Closed without deploying',
        },
    ];
}

interface SeededBoard {
    token: string;
    workId: string;
    tasks: Map<string, CreatedTask>;
    untracked: CreatedTask;
}

async function seedBoard(request: APIRequestContext): Promise<SeededBoard & { fixtures: ChipFixture[] }> {
    const token = await seededToken(request);
    const { workId } = await seedAppWork(request, token);
    const fixtures = chipFixtures();
    const tasks = new Map<string, CreatedTask>();
    for (const fixture of fixtures) {
        const task = await createWorkTask(request, token, workId, {
            title: `chip ${fixture.key}`,
        });
        const seeded = await seedTaskState(request, token, { taskId: task.id, ...fixture.seed });
        expect(seeded.deliveryState, `${fixture.key} seeded`).toBe(fixture.state);
        tasks.set(fixture.key, task);
    }
    // A Task the chain does not track: no chip at all (an App Work change that is not merged).
    const untracked = await createWorkTask(request, token, workId, { title: 'chip untracked' });
    return { token, workId, tasks, untracked, fixtures };
}

async function openBoard(page: Page, workId: string): Promise<void> {
    await gotoDashboard(page, `/en/works/${workId}/tasks`);
    // The App Work header (Delivery filter + Request a change) proves the tab knows the kind.
    await expect(page.getByTestId('work-tasks-app-header')).toBeVisible({ timeout: 45_000 });
    const kanban = page.getByRole('button', { name: 'Kanban', exact: true });
    await expect(async () => {
        await kanban.click({ timeout: 5_000 });
        await expect(kanban).toHaveAttribute('aria-pressed', 'true', { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId('task-board')).toBeVisible({ timeout: 15_000 });
}

function boardCard(page: Page, taskId: string) {
    return page.locator(`[data-testid="task-kanban-card"][data-task-id="${taskId}"]`);
}

/** The Delivery select is the custom `<Select>`: a trigger button + a portalled listbox. */
async function pickDelivery(page: Page, value: string, label: string): Promise<void> {
    const trigger = page.getByTestId('task-delivery-filter-select');
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
        if (
            !(await page
                .getByRole('option', { name: label, exact: true })
                .first()
                .isVisible()
                .catch(() => false))
        ) {
            await trigger.click({ timeout: 5_000 }).catch(() => undefined);
        }
        await page
            .locator(`[role="option"][data-value="${value}"]`)
            .first()
            .click({ timeout: 4_000 });
        await expect(trigger).toContainText(label, { timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
}

test.describe('App Works — delivery chips (APW-08 T29)', () => {
    test('every delivery state renders its chip on the board card, and an untracked Task has none', async ({
        page,
        request,
    }) => {
        const board = await seedBoard(request);

        // API half: the list embed is the chip's only input, one per tracked row.
        const list = await request.get(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(board.token),
            params: { workId: board.workId, includeDelivery: 'true', limit: '100' },
        });
        expect(list.status()).toBe(200);
        const rows = ((await list.json()) as { data: Array<{ id: string; delivery?: unknown }> }).data;
        const byId = new Map(rows.map((row) => [row.id, row]));
        expect(byId.get(board.untracked.id)?.delivery ?? null, 'untracked Task has no embed').toBeNull();
        const rolledBack = byId.get(board.tasks.get('deploy_failed_rolled_back')!.id)?.delivery as
            | { state: string; outcome: string | null }
            | undefined;
        expect(rolledBack).toMatchObject({ state: 'deploy_failed', outcome: 'rolled_back' });
        const live = byId.get(board.tasks.get('live')!.id)?.delivery as
            | { state: string; liveUrl: string | null }
            | undefined;
        expect(live).toMatchObject({ state: 'live', liveUrl: LIVE_URL });

        await openBoard(page, board.workId);

        for (const fixture of board.fixtures) {
            const task = board.tasks.get(fixture.key)!;
            const card = boardCard(page, task.id);
            await expect(card, `${fixture.key} card on the board`).toBeVisible({ timeout: 30_000 });
            const chip = card.getByTestId('task-delivery-chip');
            await expect(chip, `${fixture.key} chip`).toHaveCount(1);
            await expect(chip).toHaveAttribute('data-delivery-state', fixture.state);
            await expect(chip).toHaveText(new RegExp(`^${escapeRegExp(fixture.text)}`));
            if (fixture.href) {
                await expect(chip).toHaveAttribute('href', new RegExp(`^${escapeRegExp(fixture.href)}`));
            }
        }

        // The deploy_failed chip says its outcome in text AND as its accessible name.
        await expect(
            boardCard(page, board.tasks.get('deploy_failed_rolled_back')!.id).getByTestId(
                'task-delivery-chip',
            ),
        ).toHaveAttribute('aria-label', 'Deployment failed, rolled back');

        const untrackedCard = boardCard(page, board.untracked.id);
        await expect(untrackedCard).toBeVisible();
        await expect(untrackedCard.getByTestId('task-delivery-chip')).toHaveCount(0);
    });

    test('the Delivery filter narrows the tab to the chosen group, and Any shows every Task again', async ({
        page,
        request,
    }) => {
        const board = await seedBoard(request);
        const failedIds = ['build_failed', 'deploy_failed_failed', 'deploy_failed_rolled_back', 'deploy_failed_rollback_failed'].map(
            (key) => board.tasks.get(key)!.id,
        );

        // API half: the group's tokens filter in SQL — exactly the failed rows of this Work.
        const filtered = await request.get(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(board.token),
            params: { workId: board.workId, deliveryState: 'build_failed,deploy_failed', limit: '100' },
        });
        expect(filtered.status()).toBe(200);
        const filteredIds = ((await filtered.json()) as { data: Array<{ id: string }> }).data.map((row) => row.id);
        expect([...filteredIds].sort()).toEqual([...failedIds].sort());
        const unknown = await request.get(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(board.token),
            params: { workId: board.workId, deliveryState: 'shipped' },
        });
        expect(unknown.status(), 'an unknown delivery token is a 400').toBe(400);

        await openBoard(page, board.workId);
        await expect(page.getByTestId('task-kanban-card')).toHaveCount(board.fixtures.length + 1);

        // UI half: choose Failed, Apply → `?delivery=failed`, and only the failed cards remain.
        await pickDelivery(page, 'failed', 'Failed');
        await page.getByTestId('work-tasks-delivery-filter').getByRole('button', { name: 'Apply' }).click();
        await expect(page).toHaveURL(/[?&]delivery=failed(&|$)/, { timeout: 30_000 });
        await expect(page.getByTestId('task-delivery-filter-select')).toContainText('Failed');

        // The filtered page renders the cards view by default; every card is a link to its Task.
        const main = page.locator('main');
        for (const id of failedIds) {
            await expect(main.locator(`a[href$="/tasks/${id}"]`).first()).toBeVisible({ timeout: 30_000 });
        }
        for (const key of ['merged', 'live', 'closed', 'built']) {
            await expect(main.locator(`a[href$="/tasks/${board.tasks.get(key)!.id}"]`)).toHaveCount(0);
        }
        await expect(main.locator(`a[href$="/tasks/${board.untracked.id}"]`)).toHaveCount(0);
        const chips = main.getByTestId('task-delivery-chip');
        await expect(chips).toHaveCount(failedIds.length);
        for (const state of await chips.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-delivery-state')),
        )) {
            expect(['build_failed', 'deploy_failed']).toContain(state);
        }

        // Live narrows to the three live cards.
        await pickDelivery(page, 'live', 'Live');
        await page.getByTestId('work-tasks-delivery-filter').getByRole('button', { name: 'Apply' }).click();
        await expect(page).toHaveURL(/[?&]delivery=live(&|$)/, { timeout: 30_000 });
        await expect(main.getByTestId('task-delivery-chip')).toHaveCount(3, { timeout: 30_000 });

        // Any = no filter: every Task of the Work, the untracked one included.
        await pickDelivery(page, '', 'Any');
        await page.getByTestId('work-tasks-delivery-filter').getByRole('button', { name: 'Apply' }).click();
        await expect(page).toHaveURL(/[?&]delivery=(&|$)|\/tasks$/, { timeout: 30_000 });
        await expect(main.locator(`a[href$="/tasks/${board.untracked.id}"]`).first()).toBeVisible({
            timeout: 30_000,
        });
        await expect(main.getByTestId('task-delivery-chip')).toHaveCount(board.fixtures.length);
    });

    test('Close anyway asks first; Keep open changes nothing; confirming closes the Task as Closed without deploying', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { workId } = await seedAppWork(request, token);
        const task = await createWorkTask(request, token, workId, { title: 'close anyway' });
        // The change was in review when it merged; its Build failed.
        await transitionTask(request, token, task.id, 'in_review');
        await seedTaskState(request, token, { taskId: task.id, delivery: { state: 'build_failed', prNumber: 7 } });

        await gotoDashboard(page, `/en/tasks/${task.id}`);
        const section = page.getByTestId('task-delivery-section');
        await expect(section).toBeVisible({ timeout: 45_000 });
        await expect(section.getByTestId('task-delivery-chip')).toHaveText(/^Build failed ✗/);
        await expect(section).toContainText('Pull request #7 merged');

        // A failed change also offers Create a fix Task beside Close anyway.
        await expect(section.getByTestId('task-delivery-create-fix-task')).toHaveText('Create a fix Task');

        // 1 — Close anyway opens the confirmation (a portalled dialog); Keep open dismisses it and
        //     nothing is written.
        const close = section.getByTestId('task-delivery-close');
        await expect(close).toHaveText('Close anyway');
        await close.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toContainText(
            "Close this Task even though its change isn't live? The failure stays on record.",
        );
        await expect(page.getByTestId('task-delivery-confirm-close')).toHaveText('Close anyway');
        await page.getByTestId('task-delivery-keep-open').click();
        await expect(page.getByTestId('task-delivery-confirm-close')).toHaveCount(0);
        const kept = await request.get(`${API_BASE}/api/tasks/${task.id}/delivery`, {
            headers: authedHeaders(token),
        });
        expect(((await kept.json()) as { state: string }).state).toBe('build_failed');
        expect((await readTask(request, token, task.id)).status).toBe('in_review');

        // 2 — Close anyway → Close anyway: the chain reads Closed without deploying, the Task is Done.
        await section.getByTestId('task-delivery-close').click();
        await page.getByTestId('task-delivery-confirm-close').click();
        await expect(section.getByTestId('task-delivery-chip')).toHaveText('Closed without deploying', {
            timeout: 30_000,
        });
        await expect(section.getByTestId('task-delivery-close')).toHaveCount(0);

        const after = await request.get(`${API_BASE}/api/tasks/${task.id}/delivery`, {
            headers: authedHeaders(token),
        });
        expect(after.status()).toBe(200);
        const view = (await after.json()) as {
            state: string;
            followUps: unknown[];
            history: Array<{ state: string }>;
        };
        expect(view.state).toBe('closed_without_deploy');
        expect(view.followUps, 'no follow-up is opened by Close anyway (FR-40)').toEqual([]);
        expect((await readTask(request, token, task.id)).status).toBe('done');

        // 3 — the API refuses a second close: a closed change is not closable.
        const again = await request.post(`${API_BASE}/api/tasks/${task.id}/delivery/close`, {
            headers: authedHeaders(token),
            data: {},
        });
        expect(again.status()).toBe(422);
        expect(((await again.json()) as { code?: string }).code).toBe('notClosable');

        // The reload reads the same answer from the server.
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('task-delivery-section').getByTestId('task-delivery-chip')).toHaveText(
            'Closed without deploying',
            { timeout: 45_000 },
        );
    });

    test('a built change on an App Work that is not deployed reads Built ✓ · Waiting for a deployment and offers Close without deploying', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { workId } = await seedAppWork(request, token);
        const task = await createWorkTask(request, token, workId, { title: 'built waits' });
        await transitionTask(request, token, task.id, 'in_review');
        await seedTaskState(request, token, { taskId: task.id, delivery: { state: 'built' } });

        await gotoDashboard(page, `/en/tasks/${task.id}`);
        const section = page.getByTestId('task-delivery-section');
        await expect(section).toBeVisible({ timeout: 45_000 });
        await expect(section.getByTestId('task-delivery-chip')).toHaveText(/^Built ✓ · Waiting for a deployment/);
        // `built` is closable but not a failure: the action reads "Close without deploying".
        await expect(section.getByTestId('task-delivery-close')).toHaveText('Close without deploying');
        // No deploy target is configured on the seeded Work, so Deploy now is not offered.
        await expect(section.getByTestId('task-delivery-deploy-now')).toHaveCount(0);
        await expect(section.getByTestId('task-delivery-create-fix-task')).toHaveCount(0);
        // The Task stays open at `built` (ACC-08-21) — nothing moved it.
        expect((await readTask(request, token, task.id)).status).toBe('in_review');
    });
});

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
