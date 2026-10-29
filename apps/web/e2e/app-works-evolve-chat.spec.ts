import { test, expect, type APIRequestContext, type Page, type Route } from '@playwright/test';
import { API_BASE, authedHeaders } from './helpers/api';
import { chatComposer, openChatPanel } from './helpers/chat';
import {
    gotoDashboard,
    readTask,
    seedAppWork,
    seedTaskState,
    seededToken,
    uniq,
} from './helpers/app-works-evolve';

/**
 * APW-08 T29 (plan §9.4) — **evolve chat**: Work chat → confirmation → Task created → chain card
 * renders, with the model mocked at the provider boundary. ACC-08-24 (a chat change request
 * shows the card; **Start** creates one Task and run), FR-44 (the chain card follows the change
 * to Live), and the Tasks tab's **Request a change** button (spec §5.1).
 *
 * ## What is mocked, and what is real
 *
 * Only the MODEL. The browser's `POST /api/chat` (the AI SDK UI-message stream the docked
 * assistant reads) is answered by `page.route` with the frames the real route streams for a
 * `request_app_change` tool call:
 *
 *   1. the first turn answers the tool's confirmation marker — exactly what
 *      `lib/ai/tools/generated/factory.ts` returns for a `requiresConfirmation` operation called
 *      without the user's confirmation (`{ __confirmationRequired, toolName, action, target, args }`);
 *   2. the turn the card's **Start** button sends ("Yes, I confirm — proceed with
 *      request_app_change …") is answered by doing what the tool does once confirmed: the spec
 *      calls the REAL `POST /api/works/:id/evolve` with the same arguments (`channel: 'chat'`)
 *      and streams its answer back as the tool output (`{ success: true, data }`, `callApi`'s
 *      shape).
 *
 * Everything the card then shows is the platform's: the Work and Agent names
 * (`getAppChangeTargetAction`), the filed Task, and the chain's steps read every 10 s through
 * `getTaskChangeChainAction` → `GET /api/tasks/:id`. The chain is moved to Live by APW-08 T29's
 * seed route (no Build or Deployment exists on this lane) and the card is asserted to follow.
 */

const CHANGE_TOOL = 'request_app_change';

interface UiMessage {
    role?: string;
    parts?: Array<{ type?: string; text?: string }>;
}

/** The text of the newest user message the browser sent. */
function lastUserText(route: Route): string {
    const body = (route.request().postDataJSON() ?? {}) as { messages?: UiMessage[] };
    const last = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
    return (last?.parts ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(' ');
}

/** One AI SDK UI-message stream (SSE), `[DONE]`-terminated, as `/api/chat` answers it. */
function uiStream(chunks: Array<Record<string, unknown>>): string {
    return (
        chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    );
}

async function fulfillStream(route: Route, chunks: Array<Record<string, unknown>>): Promise<void> {
    await route.fulfill({
        status: 200,
        headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'x-vercel-ai-ui-message-stream': 'v1',
        },
        body: uiStream(chunks),
    });
}

function toolTurn(toolCallId: string, input: unknown, output: unknown, reply?: string) {
    const chunks: Array<Record<string, unknown>> = [
        { type: 'start', messageId: `msg-${toolCallId}` },
        { type: 'start-step' },
        { type: 'tool-input-start', toolCallId, toolName: CHANGE_TOOL },
        { type: 'tool-input-available', toolCallId, toolName: CHANGE_TOOL, input },
        { type: 'tool-output-available', toolCallId, output },
        { type: 'finish-step' },
    ];
    if (reply) {
        chunks.push(
            { type: 'start-step' },
            { type: 'text-start', id: `${toolCallId}-text` },
            { type: 'text-delta', id: `${toolCallId}-text`, delta: reply },
            { type: 'text-end', id: `${toolCallId}-text` },
            { type: 'finish-step' },
        );
    }
    chunks.push({ type: 'finish', finishReason: 'stop' });
    return chunks;
}

function textTurn(id: string, reply: string) {
    return [
        { type: 'start', messageId: `msg-${id}` },
        { type: 'start-step' },
        { type: 'text-start', id },
        { type: 'text-delta', id, delta: reply },
        { type: 'text-end', id },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
    ];
}

interface ChatFixture {
    token: string;
    workId: string;
    workName: string;
    agentId: string;
    agentName: string;
}

async function seedChatFixture(request: APIRequestContext): Promise<ChatFixture> {
    const token = await seededToken(request);
    const workName = `Bookings ${uniq()}`;
    const { workId } = await seedAppWork(request, token, workName);
    const agentName = `Wren ${uniq()}`;
    const agent = await request.post(`${API_BASE}/api/agents`, {
        headers: authedHeaders(token),
        data: { scope: 'work', workId, name: agentName, permissions: { canCommitToRepo: true } },
    });
    expect(agent.status(), `POST /api/agents ${await agent.text().catch(() => '')}`).toBe(201);
    const agentId = ((await agent.json()) as { id: string }).id;
    return { token, workId, workName, agentId, agentName };
}

async function changeTasks(
    request: APIRequestContext,
    token: string,
    workId: string,
): Promise<Array<{ id?: string; taskId?: string }>> {
    const res = await request.get(`${API_BASE}/api/works/${workId}/evolve`, {
        headers: authedHeaders(token),
    });
    expect(res.status(), 'GET /api/works/:id/evolve').toBe(200);
    const body = (await res.json()) as unknown;
    if (Array.isArray(body)) return body as Array<{ id?: string; taskId?: string }>;
    const record = body as { data?: unknown; items?: unknown; tasks?: unknown };
    return (record.data ?? record.items ?? record.tasks ?? []) as Array<{
        id?: string;
        taskId?: string;
    }>;
}

/**
 * Mock the model for one chat change on `fixture`'s Work: the first turn asks to confirm, the
 * confirming turn files the change through the real evolve route, a cancel turn files nothing.
 */
async function mockChangeModel(
    page: Page,
    request: APIRequestContext,
    fixture: ChatFixture,
    requestText: string,
): Promise<{ turns: string[]; filed: Array<{ taskId: string; taskSlug: string }> }> {
    const turns: string[] = [];
    const filed: Array<{ taskId: string; taskSlug: string }> = [];
    const input = {
        id: fixture.workId,
        body: { request: requestText, agentId: fixture.agentId, channel: 'chat' },
    };
    await page.route(
        (url) => url.pathname === '/api/chat',
        async (route) => {
            if (route.request().method() !== 'POST') return route.continue();
            const text = lastUserText(route);
            turns.push(text);
            if (/I confirm — proceed with request_app_change/.test(text)) {
                // What the confirmed tool call does: the real evolve route, as the signed-in person.
                const res = await request.post(`${API_BASE}/api/works/${fixture.workId}/evolve`, {
                    headers: authedHeaders(fixture.token),
                    data: input.body,
                });
                const data = (await res.json()) as { taskId: string; taskSlug: string };
                expect(res.status(), `evolve answered ${JSON.stringify(data)}`).toBe(202);
                filed.push({ taskId: data.taskId, taskSlug: data.taskSlug });
                return fulfillStream(
                    route,
                    toolTurn(`call-start-${turns.length}`, input, { success: true, data }),
                );
            }
            if (/No, cancel request_app_change/.test(text)) {
                return fulfillStream(
                    route,
                    textTurn(`cancel-${turns.length}`, 'Okay — nothing was started.'),
                );
            }
            // The model's first answer to the request: the tool, behind its confirmation.
            return fulfillStream(
                route,
                toolTurn(`call-ask-${turns.length}`, input, {
                    __confirmationRequired: true,
                    toolName: CHANGE_TOOL,
                    action: 'Ask an agent to change an App Work (a running app)',
                    target: fixture.workId,
                    args: input,
                    confirmationKind: 'destructive',
                }),
            );
        },
    );
    return { turns, filed };
}

async function askInChat(page: Page, workId: string, text: string): Promise<void> {
    await openChatPanel(page, `/en/works/${workId}/tasks`);
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    const composer = chatComposer(page);
    await composer.click();
    await composer.fill(text);
    // A send clears the composer. Under `next dev` the first Enter can land before the composer
    // is hydrated (it then only adds a newline), so Enter is pressed until the send happens.
    await expect(async () => {
        if ((await composer.inputValue()).trim().length === 0) return;
        await composer.press('Enter');
        await expect(composer).toHaveValue('', { timeout: 3_000 });
    }).toPass({ timeout: 45_000 });
}

test.describe('App Works — chat change request (APW-08 T29)', () => {
    test('the chat asks before starting; Start files one Task on the App Work and the chain card follows it to Live', async ({
        page,
        request,
    }) => {
        const fixture = await seedChatFixture(request);
        const requestText = `Add a dark mode toggle to the settings page ${uniq()}`;
        const model = await mockChangeModel(page, request, fixture, requestText);

        await askInChat(page, fixture.workId, requestText);

        // 1 — the confirmation card, with the platform's names for the Work and the Agent.
        const confirm = page.getByTestId('chat-change-card-confirm');
        await expect(confirm).toBeVisible({ timeout: 45_000 });
        await expect(confirm).toContainText(`Start a change on ${fixture.workName}?`, {
            timeout: 30_000,
        });
        await expect(confirm).toContainText(
            `${fixture.agentName} will work on it. An agent run will start; runs are billed to your workspace.`,
        );
        await expect(page.getByTestId('chat-change-card-request')).toHaveText(requestText);
        // Nothing is filed before Start.
        expect(await changeTasks(request, fixture.token, fixture.workId)).toHaveLength(0);

        // 2 — Start: the card resolves and the confirming turn files the change.
        const startedAt = Date.now();
        await page.getByTestId('chat-change-card-start').click();
        await expect(page.getByTestId('chat-change-card-resolved')).toBeVisible();
        const chain = page.getByTestId('chat-change-card-chain');
        await expect(chain).toBeVisible({ timeout: 45_000 });
        expect(model.filed, 'exactly one change was filed').toHaveLength(1);
        const { taskId, taskSlug } = model.filed[0];
        expect(Date.now() - startedAt, 'Start files the Task within seconds').toBeLessThan(30_000);
        expect(model.turns.some((turn) => turn.includes('(confirmed: true'))).toBe(true);

        // The API half: one Task on the Work, labelled as a change, assigned to the chosen Agent,
        // carrying the request as its brief; and one run was asked for it.
        const filed = await changeTasks(request, fixture.token, fixture.workId);
        expect(filed).toHaveLength(1);
        const task = await readTask(request, fixture.token, taskId);
        expect(task.workId).toBe(fixture.workId);
        expect(task.agentId).toBe(fixture.agentId);
        expect(task.labels as string[]).toContain('app-change');
        expect(String(task.description ?? '')).toContain(requestText);

        // 3 — the chain card: the filed Task, five steps each with its state as text.
        await expect(chain).toHaveAttribute('data-task-id', taskId);
        await expect(chain).toContainText(`Started ${taskSlug} on ${fixture.workName}.`, {
            timeout: 30_000,
        });
        for (const step of ['run', 'pullRequest', 'build', 'deployment', 'live']) {
            await expect(chain.getByTestId(`chat-change-step-${step}`)).toHaveCount(1);
        }
        await expect(chain.getByTestId('chat-change-step-live')).toHaveAttribute(
            'data-state',
            'pending',
        );
        await expect(chain.getByTestId('chat-change-step-live')).toContainText('Live: not started');
        await expect(chain.getByTestId('chat-change-card-open-task')).toHaveAttribute(
            'href',
            new RegExp(`/tasks/${taskId}$`),
        );

        // 4 — the change merges and goes live; the card's 10-second refresh follows it.
        await seedTaskState(request, fixture.token, {
            taskId,
            delivery: {
                state: 'live',
                prNumber: 12,
                deployment: { state: 'READY', website: 'https://bookings-e2e.apps-e2e.local' },
            },
        });
        for (const step of ['run', 'pullRequest', 'build', 'deployment', 'live']) {
            await expect(chain.getByTestId(`chat-change-step-${step}`)).toHaveAttribute(
                'data-state',
                'done',
                { timeout: 40_000 },
            );
        }
        await expect(chain.getByTestId('chat-change-step-live')).toContainText('Live: done');

        // 5 — Open the Task lands on the filed Task.
        await chain.getByTestId('chat-change-card-open-task').click();
        await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}(\\?|$)`), { timeout: 45_000 });
    });

    test('Cancel on the confirmation card files nothing', async ({ page, request }) => {
        const fixture = await seedChatFixture(request);
        const requestText = `Rename the Book button ${uniq()}`;
        const model = await mockChangeModel(page, request, fixture, requestText);

        await askInChat(page, fixture.workId, requestText);
        const confirm = page.getByTestId('chat-change-card-confirm');
        await expect(confirm).toBeVisible({ timeout: 45_000 });
        await page.getByTestId('chat-change-card-cancel').click();
        await expect(page.getByTestId('chat-change-card-resolved')).toContainText('Cancelled');
        await expect(page.getByText('Okay — nothing was started.')).toBeVisible({
            timeout: 30_000,
        });

        expect(model.turns.some((turn) => /No, cancel request_app_change/.test(turn))).toBe(true);
        expect(model.filed).toHaveLength(0);
        expect(await changeTasks(request, fixture.token, fixture.workId)).toHaveLength(0);
        await expect(page.getByTestId('chat-change-card-chain')).toHaveCount(0);
    });

    test('Request a change on the Tasks tab files the change through the same evolve route', async ({
        page,
        request,
    }) => {
        const fixture = await seedChatFixture(request);
        const requestText = `Show opening hours in the footer ${uniq()}`;

        await gotoDashboard(page, `/en/works/${fixture.workId}/tasks`);
        await expect(page.getByTestId('work-tasks-app-header')).toBeVisible({ timeout: 45_000 });
        const open = page.getByTestId('app-change-open');
        await expect(open).toHaveText(/Request a change/);
        const dialog = page.getByTestId('app-change-dialog');
        // The header button is server-rendered before it is hydrated: click until it opens.
        await expect(async () => {
            await open.click({ timeout: 5_000 });
            await expect(dialog).toBeVisible({ timeout: 2_000 });
        }).toPass({ timeout: 30_000 });
        await expect(dialog).toContainText('Request a change to this app');
        await page.getByTestId('app-change-text').fill(requestText);
        await page.getByTestId('app-change-submit').click();

        const filedNote = page.getByTestId('app-change-filed');
        await expect(filedNote).toBeVisible({ timeout: 45_000 });
        const tasks = await changeTasks(request, fixture.token, fixture.workId);
        expect(tasks).toHaveLength(1);
        const taskId = String(tasks[0].id ?? tasks[0].taskId);
        const task = await readTask(request, fixture.token, taskId);
        await expect(filedNote).toContainText(`Change filed as ${String(task.slug)}.`);
        // The Agent was resolved by the platform's rule — the one committing Agent on this Work.
        expect(task.agentId).toBe(fixture.agentId);
        expect(String(task.description ?? '')).toContain(requestText);

        await page.getByTestId('app-change-task-link').click();
        await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}(\\?|$)`), { timeout: 45_000 });
    });
});
