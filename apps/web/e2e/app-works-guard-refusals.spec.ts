import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import {
    createWorkTask,
    gotoDashboard,
    readTask,
    seedAppWork,
    seedTaskState,
    seededToken,
    type TaskSeedBody,
} from './helpers/app-works-evolve';

/**
 * APW-08 T29 (plan §9.4) — **guard refusals**: the protected-path, too-many-files and too-large
 * refusals on Task detail, and the not-admitted copy.
 *
 * ACC-08-11 (protected path, `.github/workflows/` file → no pull request, the refusal shown),
 * ACC-08-12 (a rename out of a protected path is refused; a change over 300 files is refused),
 * ACC-08-14 (over the guidance → a note; over 3× → no pull request; lockfile lines not counted),
 * and the request-time refusals of `POST /api/works/:id/evolve` as the **Request a change**
 * dialog shows them (FR-9 no committing Agent; FR-12 a cloud run cannot publish).
 *
 * ## Where the refusal text comes from
 *
 * The change guard runs on the worker's finalize path after an agent pushed a branch; an
 * in-memory SQLite lane has no git provider and no agent run. APW-08 T29's non-production seed
 * route (`POST /api/e2e/app-works/task-seed`) therefore takes the guard's INPUTS — the App rules
 * at the base commit and the branch's diff — runs the real `AppChangeGuard` over them, and
 * records its verdict on the Task the way the post-push judgement does (`branchRef`,
 * `branchState: 'pushed'`, `branchGuardRefusal`). The copy asserted below is the guard's own
 * sentence and the banner is the product's `TaskBranchSection` reading that row through
 * `GET /api/tasks/:id`; nothing here is fixture text.
 *
 * ## Not built yet, and said so
 *
 * The **not admitted** copy (spec §6.3 "No safe runtime" / "Check not admitted", ACC-08-08 and
 * ACC-08-10) belongs to isolated-run admission (T12) and App checks on Fleet nodes (T13/T14),
 * neither of which is on `develop` — there is no surface that renders it. That case is a
 * `test.fixme` naming those tasks, so it turns into a failure to fix rather than a silent pass
 * when they land.
 */

const BRAND = 'apps/web/public/brand/**';

async function refusedTask(
    request: APIRequestContext,
    token: string,
    workId: string,
    title: string,
    guard: NonNullable<TaskSeedBody['guard']>,
) {
    const task = await createWorkTask(request, token, workId, { title });
    const seeded = await seedTaskState(request, token, { taskId: task.id, guard });
    return { task, verdict: seeded.guard! };
}

async function openTaskBranch(page: Page, taskId: string) {
    await gotoDashboard(page, `/en/tasks/${taskId}`);
    const section = page.getByTestId('task-branch-section');
    await expect(section).toBeVisible({ timeout: 45_000 });
    return section;
}

test.describe('App Works — change-guard refusals on Task detail (APW-08 T29)', () => {
    test('a protected path is refused: no pull request, and the Task page names the guard and the path', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { workId } = await seedAppWork(request, token);
        const { task, verdict } = await refusedTask(request, token, workId, 'touch the brand', {
            protectedPaths: [BRAND],
            files: [
                { path: 'apps/web/public/brand/logo.svg', additions: 4, deletions: 2 },
                { path: 'apps/web/src/header.tsx', additions: 10 },
            ],
        });

        // API half — the real guard's verdict.
        expect(verdict.allowed).toBe(false);
        expect(verdict.code).toBe('protectedPath');
        expect(verdict.paths).toEqual(['apps/web/public/brand/logo.svg']);
        expect(verdict.message).toBe(
            'This change edits paths this Work protects, which an agent may not change.',
        );
        const row = await readTask(request, token, task.id);
        expect(row.branchState).toBe('pushed');
        expect(row.prNumber ?? null, 'no pull request was opened').toBeNull();

        // UI half — the branch panel's refusal banner.
        const section = await openTaskBranch(page, task.id);
        const banner = section.getByTestId('task-guard-refusal-banner');
        await expect(banner).toBeVisible();
        await expect(banner).toHaveAttribute('role', 'alert');
        await expect(banner).toContainText("An App Work's change guard blocked this branch");
        const reason = section.getByTestId('task-guard-refusal-reason');
        await expect(reason).toContainText(
            'This change edits paths this Work protects, which an agent may not change.',
        );
        await expect(reason).toContainText('The branch was pushed but no pull request was opened.');
        await expect(reason).toContainText('apps/web/public/brand/logo.svg');
        // The unprotected file is not named as an offender.
        await expect(reason).not.toContainText('apps/web/src/header.tsx');
        // No pull-request link is offered for a refused change that opened none.
        await expect(section.getByTestId('task-branch-pr-link')).toHaveCount(0);
    });

    test('a workflow file is always protected, and a rename OUT of a protected path is refused too', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { workId } = await seedAppWork(request, token);

        // `.github/workflows/**` is protected whatever the App spec says (no protectedPaths given).
        const workflow = await refusedTask(request, token, workId, 'edit CI', {
            files: [{ path: '.github/workflows/ci.yml', additions: 3, deletions: 1 }],
        });
        expect(workflow.verdict.code).toBe('workflowPath');
        expect(workflow.verdict.paths).toEqual(['.github/workflows/ci.yml']);

        // Moving the logo out of the protected folder is a change to the protected OLD path.
        const rename = await refusedTask(request, token, workId, 'move the logo', {
            protectedPaths: [BRAND],
            files: [
                {
                    path: 'apps/web/public/logo.svg',
                    previousPath: 'apps/web/public/brand/logo.svg',
                    status: 'renamed',
                },
            ],
        });
        expect(rename.verdict.code).toBe('protectedPath');
        expect(rename.verdict.paths.join(' ')).toContain('apps/web/public/brand/logo.svg');

        let section = await openTaskBranch(page, workflow.task.id);
        await expect(section.getByTestId('task-guard-refusal-reason')).toContainText(
            'This change edits the repository workflow files',
        );
        await expect(section.getByTestId('task-guard-refusal-reason')).toContainText(
            '.github/workflows/ci.yml',
        );

        section = await openTaskBranch(page, rename.task.id);
        await expect(section.getByTestId('task-guard-refusal-reason')).toContainText(
            'This change edits paths this Work protects',
        );
        await expect(section.getByTestId('task-guard-refusal-reason')).toContainText(
            'apps/web/public/brand/logo.svg',
        );
    });

    test('a change of 300 files or more is refused as too many to check', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { workId } = await seedAppWork(request, token);
        const { task, verdict } = await refusedTask(request, token, workId, 'huge change', {
            protectedPaths: [BRAND],
            files: [{ path: 'src/one.ts', additions: 1 }],
            totalFiles: 300,
        });
        expect(verdict.code).toBe('diffTooLarge');
        expect(verdict.message).toBe(
            "This change touches 300 files, which is too many to check against this Work's protected paths. Split it into smaller pull requests.",
        );

        // 299 files is judged normally (and here allowed): the cap is "300 or more".
        const under = await createWorkTask(request, token, workId, { title: '299 files' });
        const judged = await seedTaskState(request, token, {
            taskId: under.id,
            guard: {
                protectedPaths: [BRAND],
                files: [{ path: 'src/one.ts', additions: 1 }],
                totalFiles: 299,
            },
        });
        expect(judged.guard?.allowed).toBe(true);
        expect((await readTask(request, token, under.id)).branchGuardRefusal ?? null).toBeNull();

        const section = await openTaskBranch(page, task.id);
        await expect(section.getByTestId('task-guard-refusal-reason')).toContainText(
            'This change touches 300 files, which is too many to check',
        );
    });

    test('size: over 3× the guidance is refused; over the guidance is a note only; lockfile lines are not counted', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { workId } = await seedAppWork(request, token);

        // 1,300 changed lines against a guidance of 400 → refused (the ceiling is 3 × 400).
        const big = await refusedTask(request, token, workId, 'too large', {
            sizeGuidance: 400,
            files: [
                { path: 'src/a.ts', additions: 900, deletions: 100 },
                { path: 'src/b.ts', additions: 300 },
            ],
        });
        expect(big.verdict.code).toBe('tooManyLines');
        expect(big.verdict.changedLines).toBe(1300);
        expect(big.verdict.message).toBe(
            'This change is 1300 lines, more than 3× this Work’s guidance of 400. Split it into smaller pull requests.',
        );

        // 612 lines of code plus a 5,000-line lockfile → allowed with a note; nothing recorded.
        const noted = await createWorkTask(request, token, workId, { title: 'over guidance' });
        const allowed = await seedTaskState(request, token, {
            taskId: noted.id,
            guard: {
                sizeGuidance: 400,
                files: [
                    { path: 'src/c.ts', additions: 600, deletions: 12 },
                    { path: 'pnpm-lock.yaml', additions: 4000, deletions: 1000 },
                ],
            },
        });
        expect(allowed.guard?.allowed).toBe(true);
        expect(allowed.guard?.changedLines, 'lockfile lines are not counted').toBe(612);
        expect(allowed.guard?.note ?? '').toContain('612 lines');
        expect(allowed.guard?.branchGuardRefusal ?? null).toBeNull();
        const notedRow = await readTask(request, token, noted.id);
        expect(notedRow.branchGuardRefusal ?? null).toBeNull();
        expect(notedRow.branchRef ?? null, 'an allowed change writes nothing').toBeNull();

        const section = await openTaskBranch(page, big.task.id);
        await expect(section.getByTestId('task-guard-refusal-reason')).toContainText(
            'This change is 1300 lines, more than 3× this Work’s guidance of 400.',
        );

        // The allowed Task has no branch panel at all (no branch was recorded) — and no banner.
        await gotoDashboard(page, `/en/tasks/${noted.id}`);
        await expect(page.getByTestId('task-isolation-override-section')).toBeVisible({
            timeout: 45_000,
        });
        await expect(page.getByTestId('task-guard-refusal-banner')).toHaveCount(0);
    });

    test('Request a change without a committing Agent is refused with the agentRequired copy, and nothing is filed', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const { workId } = await seedAppWork(request, token);

        // API half — the same refusal the dialog renders (FR-9): 409 `agentRequired`. (Whether it
        // also offers the template depends on whether the account holds committing Agents on OTHER
        // Works — the evolve-chat spec creates one — so only the code is pinned here.)
        const refused = await request.post(`${API_BASE}/api/works/${workId}/evolve`, {
            headers: authedHeaders(token),
            data: { request: 'Make the header blue', channel: 'api' },
        });
        expect(refused.status()).toBe(409);
        expect(await refused.json()).toMatchObject({ status: 'refused', code: 'agentRequired' });

        await gotoDashboard(page, `/en/works/${workId}/tasks`);
        // The header button is server-rendered before it is hydrated: click until it opens.
        await expect(async () => {
            await page.getByTestId('app-change-open').click({ timeout: 5_000 });
            await expect(page.getByTestId('app-change-dialog')).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await page.getByTestId('app-change-text').fill('Make the header blue');
        await page.getByTestId('app-change-submit').click();
        const error = page.getByTestId('app-change-error');
        await expect(error).toBeVisible({ timeout: 30_000 });
        await expect(error).toHaveAttribute('data-code', 'agentRequired');
        await expect(error).toHaveText(
            'No Agent is set up to change this App Work yet. Create one (for example from the App Engineer template) or assign one, then try again.',
        );
        await expect(page.getByTestId('app-change-filed')).toHaveCount(0);

        // Nothing was filed on the Work.
        const list = await request.get(`${API_BASE}/api/tasks`, {
            headers: authedHeaders(token),
            params: { workId },
        });
        expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(0);
    });

    test('an Agent that may not commit is refused (agentNotEligible) — changes to an app always go through a branch', async ({
        request,
    }) => {
        const token = await seededToken(request);
        const { workId } = await seedAppWork(request, token);
        const agent = await request.post(`${API_BASE}/api/agents`, {
            headers: authedHeaders(token),
            data: { scope: 'work', workId, name: `No commit ${Date.now().toString(36)}` },
        });
        expect(agent.status()).toBe(201);
        const agentId = ((await agent.json()) as { id: string }).id;

        const refused = await request.post(`${API_BASE}/api/works/${workId}/evolve`, {
            headers: authedHeaders(token),
            data: { request: 'Make the header blue', agentId },
        });
        expect(refused.status()).toBe(422);
        const body = (await refused.json()) as { code: string; message: string };
        expect(body.code).toBe('agentNotEligible');
        expect(body.message).toContain('may not commit to repositories');
    });

    test.fixme('not admitted: with no Fleet node and no isolated environment no run starts and the S15 copy shows (ACC-08-08, ACC-08-10)', async () => {
        // Unbuilt on develop: isolated-run admission (APW-08 T12) and App checks on Fleet nodes
        // (T13/T14) have no surface yet — no Task-page copy reads "This app's code can only run
        // on one of your machines or in an isolated sandbox, and none is set up." or "Not
        // admitted — review this check before it runs on your machines." When they land, seed
        // an App Work with no Fleet node, press Run on its Task and assert that copy here.
    });
});
