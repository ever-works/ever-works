import {
    test,
    expect,
    type APIRequestContext,
    type Locator,
    type Page,
    type Request,
} from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { clickUntil } from './helpers/nav';
import { loadSeededTestUser } from './helpers/seeded-test-user';

/**
 * AW-21 — saved workflow graphs get a screen.
 *
 * Workflows are saved through the existing `/api/workflows` routes; the
 * catalogue lists them, runs one from the list, and shows its run history
 * and trace. The run control answers as soon as the run is recorded — in a
 * stack without a job runtime that run is recorded as not accepted, which the
 * row says plainly instead of showing a queue that never moves. An archived
 * workflow offers Reactivate instead of Run.
 */

async function seededToken(request: APIRequestContext): Promise<string> {
    const seeded = loadSeededTestUser();
    const res = await request.post(`${API_BASE}/api/auth/login`, {
        data: { email: seeded.email, password: seeded.password },
    });
    expect(res.status()).toBe(200);
    return (await res.json()).access_token as string;
}

async function createWorkflow(
    request: APIRequestContext,
    token: string,
    name: string,
    status: 'active' | 'draft' | 'archived',
): Promise<string> {
    const res = await request.post(`${API_BASE}/api/workflows`, {
        headers: authedHeaders(token),
        data: {
            name,
            status,
            graph: { id: 'g-e2e', entryNodeId: 'a', nodes: [{ id: 'a', kind: 'noop' }], edges: [] },
        },
    });
    expect(res.status(), `create workflow body=${await res.text()}`).toBe(201);
    return ((await res.json()) as { id: string }).id;
}

/**
 * The row's server-action POST for this workflow (`runWorkflowAction(id)` /
 * `reactivateWorkflowAction(id)`): Next posts it to the page URL with a
 * `Next-Action` header and the arguments as the body, so the workflow id is in
 * it. Other server actions the dashboard shell fires on load carry no such id.
 */
function isRowAction(request: Request, workflowId: string): boolean {
    return (
        request.method() === 'POST' &&
        request.headers()['next-action'] !== undefined &&
        (request.postData() ?? '').includes(workflowId)
    );
}

/**
 * How far one row's server action got, as the browser saw it. Next sends an
 * action's response headers only after the action function has returned, and
 * because these actions call `revalidatePath` the body then streams the
 * re-rendered route. So `answeredAt` and `finishedAt` split the server's time
 * into the action itself and the re-render.
 */
interface RowActionTrace {
    sentAt?: number;
    answeredAt?: number;
    status?: number;
    finishedAt?: number;
    failure?: string;
}

function traceRowAction(page: Page, workflowId: string): RowActionTrace {
    const trace: RowActionTrace = {};
    const mine = (request: Request) => isRowAction(request, workflowId);
    page.on('request', (request) => {
        if (trace.sentAt === undefined && mine(request)) trace.sentAt = Date.now();
    });
    page.on('response', (response) => {
        if (trace.answeredAt === undefined && mine(response.request())) {
            trace.answeredAt = Date.now();
            trace.status = response.status();
        }
    });
    page.on('requestfinished', (request) => {
        if (trace.finishedAt === undefined && mine(request)) trace.finishedAt = Date.now();
    });
    page.on('requestfailed', (request) => {
        if (trace.failure === undefined && mine(request)) {
            trace.failure = request.failure()?.errorText ?? 'unknown error';
        }
    });
    return trace;
}

const DONE = 'done';
const NO_CLICK_LANDED = 'no click has landed: the button is idle and no action request was sent';

/**
 * One line saying where a row interaction stands, or `DONE` once `done()`
 * holds. A failing wait below prints it as "Received", so a red run names the
 * stage it stopped at. That tells apart the two causes the CI log alone could
 * not: a click the page never acted on (`NO_CLICK_LANDED`), and a click that
 * landed while the server, or the browser's handling of the answer, was slow.
 */
async function rowActionStage(
    trace: RowActionTrace,
    control: Locator,
    done: () => Promise<boolean>,
): Promise<string> {
    if (await done()) return DONE;
    const sentAt = trace.sentAt;
    if (sentAt === undefined) {
        const busy = await control.isDisabled({ timeout: 1_000 }).catch(() => false);
        return busy
            ? 'a click landed (the button is busy) but the action request was never sent'
            : NO_CLICK_LANDED;
    }
    const after = (at: number) => `${at - sentAt} ms`;
    if (trace.failure !== undefined) {
        return `the action request failed (${trace.failure}) ${after(Date.now())} after it was sent`;
    }
    if (trace.answeredAt === undefined) {
        return `the action request was sent and the server had not answered ${after(Date.now())} later`;
    }
    if (trace.finishedAt === undefined) {
        return (
            `the server answered ${trace.status} after ${after(trace.answeredAt)}, ` +
            `and the re-rendered route was still streaming ${after(Date.now())} after sending`
        );
    }
    return (
        `the action finished (${trace.status}, answered after ${after(trace.answeredAt)}, ` +
        `streamed by ${after(trace.finishedAt)}) but the row had not changed ${after(Date.now())} after sending`
    );
}

test.describe('Catalogue — saved workflows', () => {
    test('lists a saved workflow, runs it from the list, and shows its run', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const name = `Catalog walk ${Date.now().toString(36)}`;
        const id = await createWorkflow(request, token, name, 'active');

        await page.goto('/en/catalog/workflows', { waitUntil: 'domcontentloaded' });
        const row = page.locator(`[data-testid="workflow-row"][data-workflow-id="${id}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByTestId('workflow-status')).toHaveText('Active');
        await expect(row).toContainText('1 node');

        const runButton = row.getByRole('button', { name: `Run ${name}` });
        const feedback = row.getByTestId('workflow-row-feedback');
        // This wait timed out with no feedback in the row on the first attempt on develop
        // (57c0bd8a7, run 36158167795, shard 7) and on this branch at c7ca76c2f (run
        // 36187829618), passing on retry both times, and on all three attempts at 7411a3529
        // (run 36220455888). The CI logs do not say why.
        // Two causes fit it:
        //  - the click landed before React hydrated the server-rendered row and was dropped
        //    (the hazard `helpers/nav.ts` documents);
        //  - the click landed and the answer was slow. The action's answer carries the
        //    re-rendered route, because it calls `revalidatePath`.
        // So: re-click only while no click has landed, which cures the first cause and never
        // fires for the second. Run is NOT idempotent, so "landed" is anything a landed click
        // produces: the button turns busy (`disabled`, synchronously), the action request
        // leaves, or the feedback shows. A landed click is never repeated, and the single-run
        // check below still holds the control to exactly one run. If the wait still fails, the
        // assertion prints which stage it stopped at, so the next red run settles the cause.
        const trace = traceRowAction(page, id);
        const runStage = () => rowActionStage(trace, runButton, () => feedback.isVisible());
        await clickUntil(runButton, async () => (await runStage()) !== NO_CLICK_LANDED);
        await expect
            .poll(runStage, {
                message: 'the Run control answers within 15 s of the click that landed',
                timeout: 15_000,
            })
            .toBe(DONE);
        await expect(feedback).toHaveText(
            /^(Queued — run [0-9a-f]{8}|Run [0-9a-f]{8} was recorded, but the job runtime did not accept it\.)$/,
        );
        // The control never waits for the graph itself. Timed from when the action left the
        // browser, so a click dropped before hydration does not count against the control.
        expect(trace.sentAt, 'the Run action request (Next-Action POST) was seen').toBeDefined();
        expect(Date.now() - (trace.sentAt ?? 0)).toBeLessThan(15_000);

        const runs = await request.get(`${API_BASE}/api/workflows/${id}/runs`, {
            headers: authedHeaders(token),
        });
        expect(runs.status()).toBe(200);
        const { items } = (await runs.json()) as { items: Array<{ id: string }> };
        expect(items.length).toBe(1);

        await page.goto(`/en/catalog/workflows/${id}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByRole('heading', { level: 1, name })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId('workflow-run-history')).toContainText(
            items[0].id.slice(0, 8),
        );
        await expect(page.getByTestId('workflow-run-trace')).toHaveAttribute(
            'data-run-id',
            items[0].id,
        );
    });

    test("a run from another workflow is never rendered under this workflow's page", async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const suffix = Date.now().toString(36);
        const nameA = `Owner A ${suffix}`;
        const idA = await createWorkflow(request, token, nameA, 'active');
        const idB = await createWorkflow(request, token, `Owner B ${suffix}`, 'active');

        const started = await request.post(`${API_BASE}/api/workflows/${idB}/run`, {
            headers: authedHeaders(token),
        });
        expect(started.ok(), `run body=${await started.text()}`).toBe(true);
        const runs = await request.get(`${API_BASE}/api/workflows/${idB}/runs`, {
            headers: authedHeaders(token),
        });
        const { items } = (await runs.json()) as { items: Array<{ id: string }> };
        expect(items.length).toBe(1);

        await page.goto(`/en/catalog/workflows/${idA}?run=${items[0].id}`, {
            waitUntil: 'domcontentloaded',
        });
        await expect(page.getByRole('heading', { level: 1, name: nameA })).toBeVisible({
            timeout: 30_000,
        });
        await expect(page.getByTestId('workflow-run-mismatch')).toBeVisible();
        await expect(page.getByTestId('workflow-run-trace')).toHaveCount(0);
    });

    test('an archived workflow offers Reactivate, not Run, and running it is refused', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const name = `Archived walk ${Date.now().toString(36)}`;
        const id = await createWorkflow(request, token, name, 'archived');

        const refused = await request.post(`${API_BASE}/api/workflows/${id}/run`, {
            headers: authedHeaders(token),
        });
        expect(refused.status()).toBe(409);

        await page.goto(`/en/catalog/workflows/${id}`, { waitUntil: 'domcontentloaded' });
        const row = page.locator(`[data-testid="workflow-row"][data-workflow-id="${id}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row.getByTestId('workflow-status')).toHaveText('Archived');
        await expect(row.getByRole('button', { name: `Run ${name}` })).toHaveCount(0);
        // Same two candidate causes as the Run click above. This case failed its first attempt
        // with the row still `Archived` after 15 s on develop (57c0bd8a7, run 36158167795), at
        // c7ca76c2f (run 36187829618) and at 7411a3529 (run 36220455888), and passed on retry
        // each time. The same remedy and the same stage report apply. Reactivate is idempotent
        // (`PATCH { status: 'active' }`), so a repeat click would be harmless anyway, but the
        // re-clicking stops at the first landed click all the same. The 15 s allowed for the
        // row to read `Active` is the original bound, now counted from the click that landed.
        const status = row.getByTestId('workflow-status');
        const reactivate = row.getByRole('button', { name: 'Reactivate' });
        const trace = traceRowAction(page, id);
        const reactivateStage = () =>
            rowActionStage(
                trace,
                reactivate,
                async () => (await status.textContent())?.trim() === 'Active',
            );
        await clickUntil(reactivate, async () => (await reactivateStage()) !== NO_CLICK_LANDED);
        await expect
            .poll(reactivateStage, {
                message: 'the row reads Active within 15 s of the Reactivate click that landed',
                timeout: 15_000,
            })
            .toBe(DONE);
        await expect(status).toHaveText('Active');
    });

    test('the catalogue index lists saved workflows in its Workflows section', async ({
        page,
        request,
    }) => {
        const token = await seededToken(request);
        const name = `Index walk ${Date.now().toString(36)}`;
        const id = await createWorkflow(request, token, name, 'draft');

        await page.goto('/en/catalog', { waitUntil: 'domcontentloaded' });
        const section = page.getByTestId('catalog-section-workflows');
        await expect(section).toBeVisible({ timeout: 30_000 });
        await expect(section.locator(`[data-workflow-id="${id}"]`)).toBeVisible();
        await expect(section.getByRole('link', { name: /See all/ })).toHaveAttribute(
            'href',
            /\/catalog\/workflows$/,
        );
    });
});
