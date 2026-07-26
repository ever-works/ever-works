import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders, loginViaAPI } from './helpers/api';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * `/tasks/:id` — the Branch + Checks cockpit (Wave 2 M7 + Wave 3 M6).
 *
 * The two panels this program added to the Task detail page had zero UI
 * coverage. They are also the surfaces most likely to regress SILENTLY:
 * they render conditionally on server-owned columns, so a broken prop
 * chain shows up as "the panel simply isn't there" rather than an error.
 *
 * Seeding is API-first and navigation is direct (no click-chains) — the
 * house pattern for data-backed detail pages.
 *
 * ── What renders when (components/tasks/TaskBranchSection.tsx) ──────
 *   task.branchRef set   → BranchPanel        [task-branch-section]
 *                          + [task-conflict-banner] when
 *                            branchState === 'conflict'
 *   task.branchRef null  → IsolationOverridePanel
 *                          [task-isolation-override-section]
 *                          with the [task-isolation-override] select
 *                          (inherit / on / off → isolationMode
 *                           null / 'on' / 'off')
 *
 *   Checks section [task-checks-section] ALWAYS renders; it shows the
 *   dispatch-frozen `resolvedChecks` when a run exists, otherwise the
 *   Task's declared `acceptanceChecks`, one [task-check-row] each.
 *
 * `branchRef` / `branchState` are written only by the worker's workspace
 * finalize path and are rejected by the Task PATCH DTO
 * (forbidNonWhitelisted), so the branch/conflict arm is not reachable
 * from a black-box e2e. This spec therefore proves the INHERIT arm, the
 * checks rendering, and the round-trip of both editors — and explicitly
 * pins that the conflict banner is ABSENT for a branchless Task, which
 * is the regression that would otherwise ship unnoticed.
 */

function uniq(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const { access_token } = await loginViaAPI(request, {
        email: seeded.email,
        password: seeded.password,
    });
    expect(access_token, 'seeded login returns a bearer token').toBeTruthy();
    return access_token;
}

async function createTask(
    request: APIRequestContext,
    token: string,
    body: Record<string, unknown>,
): Promise<{ id: string; slug: string }> {
    const res = await request.post(`${API_BASE}/api/tasks`, {
        headers: authedHeaders(token),
        data: { title: `branch-ui-${uniq()}`, ...body },
    });
    expect(res.status(), `seed task body=${await res.text().catch(() => '')}`).toBe(201);
    return res.json();
}

async function readTask(
    request: APIRequestContext,
    token: string,
    id: string,
): Promise<Record<string, unknown>> {
    const res = await request.get(`${API_BASE}/api/tasks/${id}`, {
        headers: authedHeaders(token),
    });
    expect(res.status()).toBe(200);
    return res.json();
}

/** Land on the detail page and wait for a stable server-rendered anchor. */
async function gotoTask(page: Page, id: string): Promise<void> {
    await page.goto(`/en/tasks/${id}`, { waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByTestId('task-checks-section')).toBeVisible({ timeout: 30_000 });
}

/**
 * `components/ui/select` is a CUSTOM dropdown, not a native `<select>`:
 * `data-testid` lands on a trigger `<button>` whose text is the selected
 * option's label, and the options are `role="option"` rows in a
 * body-portalled `role="listbox"`. So "read the value" is a text
 * assertion on the trigger and "set the value" is click-then-click.
 * Retry-guarded for the prod-build hydration race (the CI web app is a
 * production build — the trigger is in the DOM before it is wired).
 */
async function chooseOption(page: Page, testId: string, option: RegExp): Promise<void> {
    const trigger = page.getByTestId(testId);
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await expect(async () => {
        if (
            !(await page
                .getByRole('option')
                .first()
                .isVisible()
                .catch(() => false))
        ) {
            await trigger.click({ timeout: 5_000 }).catch(() => undefined);
        }
        await page.getByRole('option', { name: option }).first().click({ timeout: 4_000 });
    }).toPass({ timeout: 30_000 });
}

test.describe('Task detail — isolation override panel', () => {
    test('a branchless Task shows the isolation select (not the branch panel) and no conflict banner', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTask(request, token, {});

        await gotoTask(page, task.id);

        await expect(page.getByTestId('task-isolation-override-section')).toBeVisible();
        await expect(page.getByTestId('task-isolation-override')).toBeVisible();
        // The branch cockpit and its conflict banner belong to the OTHER
        // arm — their presence here would mean the branchRef guard broke.
        await expect(page.getByTestId('task-branch-section')).toHaveCount(0);
        await expect(page.getByTestId('task-conflict-banner')).toHaveCount(0);
        await expect(page.getByTestId('task-resolve-conflicts')).toHaveCount(0);
        await expect(page.getByTestId('task-discard-branch')).toHaveCount(0);
    });

    test('the select reflects the persisted isolationMode', async ({ page, request }) => {
        const token = await seededToken(request);
        const inherited = await createTask(request, token, {});
        const forced = await createTask(request, token, { isolationMode: 'on' });

        await gotoTask(page, inherited.id);
        await expect(page.getByTestId('task-isolation-override')).toContainText(
            /Inherit from Work/i,
        );

        await gotoTask(page, forced.id);
        await expect(page.getByTestId('task-isolation-override')).toContainText(/isolated branch/i);
    });

    test('changing the select persists through the server action to the API', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTask(request, token, {});

        await gotoTask(page, task.id);
        await expect(page.getByTestId('task-isolation-override')).toContainText(
            /Inherit from Work/i,
        );

        await chooseOption(page, 'task-isolation-override', /work directly/i);

        // The server action PATCHes the Task — assert the API, not the DOM,
        // so a purely optimistic UI cannot make this pass.
        await expect
            .poll(async () => (await readTask(request, token, task.id)).isolationMode ?? null, {
                timeout: 20_000,
                message: 'isolationMode is persisted by the isolation select',
            })
            .toBe('off');

        // …and it survives a reload (the select is hydrated from the row).
        await gotoTask(page, task.id);
        await expect(page.getByTestId('task-isolation-override')).toContainText(/work directly/i);
    });
});

test.describe('Task detail — checks (quality gate) section', () => {
    test('renders one row per declared acceptance check', async ({ page, request }) => {
        const token = await seededToken(request);
        const task = await createTask(request, token, {
            acceptanceChecks: [
                {
                    id: 'build',
                    name: 'Build',
                    kind: 'build',
                    command: 'pnpm build',
                    required: true,
                },
                {
                    id: 'unit-tests',
                    name: 'Unit tests',
                    kind: 'test',
                    command: 'pnpm test',
                    required: false,
                },
            ],
            maxGateAttempts: 3,
        });

        await gotoTask(page, task.id);

        const section = page.getByTestId('task-checks-section');
        await expect(section).toBeVisible();
        await expect(page.getByTestId('task-check-row')).toHaveCount(2);
        await expect(section).toContainText('Build');
        await expect(section).toContainText('Unit tests');
    });

    test('a Task with no checks renders the section in its empty state, not a crash', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTask(request, token, {});

        await gotoTask(page, task.id);
        await expect(page.getByTestId('task-checks-section')).toBeVisible();
        await expect(page.getByTestId('task-check-row')).toHaveCount(0);
        // No run exists, so neither the gate chip nor the attempts counter
        // should be fabricated.
        await expect(page.getByTestId('task-gate-chip')).toHaveCount(0);
        await expect(page.getByTestId('task-gate-attempts')).toHaveCount(0);
    });

    test('the inline editor round-trips the gate-attempt budget to the API', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const task = await createTask(request, token, {
            acceptanceChecks: [
                { id: 'lint', name: 'Lint', kind: 'lint', command: 'pnpm lint', required: true },
            ],
        });

        await gotoTask(page, task.id);

        // "Edit" is a client-state toggle, so the button exists in the
        // server-rendered HTML before React has attached its handler. On
        // the PRODUCTION build the e2e suite runs against, a single click
        // can land in that window and do nothing — retry until the editor
        // actually opens (house pattern for the hydration race).
        const editor = page.getByTestId('task-checks-editor');
        await expect(async () => {
            if (!(await editor.isVisible().catch(() => false))) {
                await page
                    .getByTestId('task-checks-edit')
                    .click({ timeout: 5_000 })
                    .catch(() => undefined);
            }
            await expect(editor).toBeVisible({ timeout: 3_000 });
        }).toPass({ timeout: 30_000 });

        await expect(page.getByTestId('task-checks-editor-row')).toHaveCount(1);
        await expect(page.getByTestId('task-checks-editor-id')).toHaveValue('lint');

        await expect(page.getByTestId('task-checks-max-attempts')).toContainText(
            /Inherit from Work/i,
        );
        await chooseOption(page, 'task-checks-max-attempts', /^4$/);
        await page.getByTestId('task-checks-save').click();

        await expect
            .poll(async () => (await readTask(request, token, task.id)).maxGateAttempts ?? null, {
                timeout: 20_000,
                message: 'the checks editor persists maxGateAttempts',
            })
            .toBe(4);

        // The declared check survived the save (the editor replaces the set
        // wholesale — dropping it silently would be the bug).
        const stored = await readTask(request, token, task.id);
        expect(Array.isArray(stored.acceptanceChecks)).toBe(true);
        expect((stored.acceptanceChecks as Array<{ id: string }>)[0].id).toBe('lint');
    });
});
