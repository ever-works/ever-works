import { afterEach, describe, expect, it, vi } from 'vitest';
import { DefaultChatTransport } from 'ai';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';
import {
    INITIAL_CHAT_PANEL_STATE,
    panelBackTarget,
    parseChatPanelState,
    prepareChatRequest,
    transport,
    type ChatPanelState,
} from './ChatProvider';

/**
 * The chat transport must stamp the per-tab workspace selector on every send.
 *
 * This is not an Organization nicety. The tool loop inside `/api/chat` reaches
 * the platform through `serverFetch`, which derives its scope from this header
 * and THROWS `Invalid workspace scope` when it is absent — so a send without it
 * fails before any request leaves the web tier, in personal scope as well as
 * org scope. `api-call.ts` then swallows the throw into
 * `{ success: false }`, so the model simply apologises inside a healthy 200
 * stream: no error toast, no failed request in the network tab, nothing to
 * search for.
 *
 * `proxy.ts`'s matcher deliberately excludes `/api`, so nothing upstream can
 * supply the header on the client's behalf. If these fail, every data action
 * the in-app assistant offers is dead.
 */

type PrepareArgs = Parameters<typeof prepareChatRequest>[0];

/**
 * The SDK passes `id`, `messages`, `trigger` and `messageId` ALONGSIDE `body`,
 * never inside it. Hand-building a call without them is what let the first
 * version of this suite pass against a `prepareChatRequest` that dropped them.
 */
function sendArgs(overrides: Partial<PrepareArgs> = {}): PrepareArgs {
    return {
        id: 'conv-1',
        messages: [],
        trigger: 'submit-message',
        messageId: undefined,
        ...overrides,
    } as PrepareArgs;
}

describe('chat transport workspace selector', () => {
    afterEach(() => {
        window.history.replaceState({}, '', '/');
    });

    it('stamps the Organization selector from the visible tab URL', () => {
        window.history.replaceState({}, '', '/org/ever/dashboard');

        const { headers } = prepareChatRequest(sendArgs());

        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:ever');
    });

    it('stamps explicit personal scope on an unprefixed route — never nothing', () => {
        window.history.replaceState({}, '', '/dashboard');

        const { headers } = prepareChatRequest(sendArgs());

        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('personal');
    });

    it('restates the fields the SDK passes outside `body`, and keeps the extras', () => {
        window.history.replaceState({}, '', '/dashboard');
        const messages = [
            { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
        ] as unknown as PrepareArgs['messages'];

        const { body } = prepareChatRequest(
            sendArgs({ messages, body: { providerOverride: 'openai' } }),
        );

        expect(body).toEqual({
            providerOverride: 'openai',
            id: 'conv-1',
            messages,
            trigger: 'submit-message',
            messageId: undefined,
        });
    });

    it('re-derives per send, so navigating between turns cannot reuse a stale Organization', () => {
        window.history.replaceState({}, '', '/org/ever/chat');
        const first = prepareChatRequest(sendArgs()).headers.get(BROWSER_WORKSPACE_SCOPE_HEADER);
        window.history.replaceState({}, '', '/org/yo/chat');
        const second = prepareChatRequest(sendArgs()).headers.get(BROWSER_WORKSPACE_SCOPE_HEADER);

        expect([first, second]).toEqual(['org:ever', 'org:yo']);
    });

    it('is actually wired into the transport, not merely available', () => {
        // The original defect was the transport being constructed as
        // `new DefaultChatTransport({ api: '/api/chat' })` with no request
        // preparation at all. A spec that only exercised `prepareChatRequest`
        // would have passed against that broken code, so pin the wiring.
        // `prepareSendMessagesRequest` is `protected` on the SDK class but is a
        // plain property at runtime; the cast is deliberate.
        const wired = (
            transport as unknown as { prepareSendMessagesRequest?: typeof prepareChatRequest }
        ).prepareSendMessagesRequest;

        expect(wired).toBe(prepareChatRequest);
    });

    it('overwrites a stale caller-supplied selector rather than trusting it', () => {
        window.history.replaceState({}, '', '/org/yo/chat');

        const { headers } = prepareChatRequest(
            sendArgs({ headers: { [BROWSER_WORKSPACE_SCOPE_HEADER]: 'org:ever' } }),
        );

        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:yo');
    });

    it('puts `messages` on the wire when driven through a real transport', async () => {
        // Every test above calls `prepareChatRequest` with arguments WE build,
        // so none of them can catch the callback disagreeing with the SDK about
        // where `messages` lives. This one lets the SDK build the arguments and
        // reads the request that actually leaves: when the callback returns a
        // `body`, the SDK POSTs it verbatim rather than re-adding the fields it
        // passed separately, so dropping them here means `/api/chat` rejects
        // every send with 400 before a model is ever reached.
        window.history.replaceState({}, '', '/org/ever/chat');

        let sentBody: Record<string, unknown> | undefined;
        let sentHeaders: Headers | undefined;

        const probe = new DefaultChatTransport({
            api: '/api/chat',
            prepareSendMessagesRequest: prepareChatRequest,
            fetch: vi.fn(async (_input: unknown, init: RequestInit) => {
                sentBody = JSON.parse(String(init.body));
                sentHeaders = new Headers(init.headers as HeadersInit);
                return new Response('', {
                    status: 200,
                    headers: { 'content-type': 'text/event-stream' },
                });
            }) as unknown as typeof fetch,
        });

        await (probe as unknown as { sendMessages: (o: unknown) => Promise<unknown> })
            .sendMessages({
                chatId: 'conv-1',
                messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
                trigger: 'submit-message',
                messageId: undefined,
                metadata: undefined,
                abortSignal: undefined,
            })
            // The stub returns no parseable stream; only the request matters.
            .catch(() => undefined);

        expect(sentBody).toBeDefined();
        expect(sentBody?.id).toBe('conv-1');
        expect(Array.isArray(sentBody?.messages)).toBe(true);
        expect((sentBody?.messages as unknown[]).length).toBe(1);
        expect(sentHeaders?.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:ever');
    });
});

/**
 * The docked panel's view stack (FR-14, FR-20). A person talking to an Agent
 * walks Conversation → that Agent's list → the switcher; the assistant has no
 * per-participant list, so its Back goes straight to the switcher. The stack is
 * persisted, so a reload restores it — and anything unreadable must fall back
 * to the assistant exactly as the panel behaved before named Conversations.
 */
describe('chat panel view stack', () => {
    const agentPanel = (view: ChatPanelState['view']): ChatPanelState => ({
        view,
        participant: { kind: 'agent', agentId: 'a-1', name: 'Nova', status: 'active' },
        conversation: { id: 'c-1', title: 'Q4 pricing', context: null },
        pendingContext: null,
    });

    it('starts on the assistant Conversation, as the panel always has', () => {
        expect(INITIAL_CHAT_PANEL_STATE.view).toBe('conversation');
        expect(INITIAL_CHAT_PANEL_STATE.participant).toEqual({ kind: 'assistant' });
    });

    it('walks an Agent Conversation back to its list, then to the switcher, then stops', () => {
        expect(panelBackTarget(agentPanel('conversation'))).toBe('list');
        expect(panelBackTarget(agentPanel('list'))).toBe('switcher');
        expect(panelBackTarget(agentPanel('switcher'))).toBeNull();
    });

    it('walks the assistant straight back to the switcher', () => {
        expect(panelBackTarget(INITIAL_CHAT_PANEL_STATE)).toBe('switcher');
    });

    it('restores the last open Agent Conversation from storage', () => {
        const restored = parseChatPanelState(JSON.stringify(agentPanel('conversation')));
        expect(restored.participant).toEqual({
            kind: 'agent',
            agentId: 'a-1',
            name: 'Nova',
            status: 'active',
        });
        expect(restored.conversation).toEqual({ id: 'c-1', title: 'Q4 pricing', context: null });
    });

    it('never restores a one-off pending context', () => {
        const stored = {
            ...agentPanel('switcher'),
            pendingContext: { contextType: 'mission', contextId: 'm-1', label: 'Launch' },
        };
        expect(parseChatPanelState(JSON.stringify(stored)).pendingContext).toBeNull();
    });

    it('falls back to the assistant for missing, malformed or assistant state', () => {
        expect(parseChatPanelState(null)).toBe(INITIAL_CHAT_PANEL_STATE);
        expect(parseChatPanelState('{not json')).toBe(INITIAL_CHAT_PANEL_STATE);
        expect(parseChatPanelState(JSON.stringify({ participant: { kind: 'agent' } }))).toBe(
            INITIAL_CHAT_PANEL_STATE,
        );
        expect(parseChatPanelState(JSON.stringify(INITIAL_CHAT_PANEL_STATE))).toBe(
            INITIAL_CHAT_PANEL_STATE,
        );
    });
});
