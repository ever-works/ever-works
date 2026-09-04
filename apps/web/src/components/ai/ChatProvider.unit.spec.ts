import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER_WORKSPACE_SCOPE_HEADER } from '@/lib/workspace-scope';
import { prepareChatRequest, transport } from './ChatProvider';

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
describe('chat transport workspace selector', () => {
    afterEach(() => {
        window.history.replaceState({}, '', '/');
    });

    it('stamps the Organization selector from the visible tab URL', () => {
        window.history.replaceState({}, '', '/org/ever/dashboard');

        const { headers } = prepareChatRequest({});

        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:ever');
    });

    it('stamps explicit personal scope on an unprefixed route — never nothing', () => {
        window.history.replaceState({}, '', '/dashboard');

        const { headers } = prepareChatRequest({});

        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('personal');
    });

    it('passes the body through untouched and defaults it to an object', () => {
        window.history.replaceState({}, '', '/dashboard');

        expect(prepareChatRequest({ body: { id: 'c1', messages: [] } }).body).toEqual({
            id: 'c1',
            messages: [],
        });
        expect(prepareChatRequest({}).body).toEqual({});
    });

    it('re-derives per send, so navigating between turns cannot reuse a stale Organization', () => {
        window.history.replaceState({}, '', '/org/ever/chat');
        const first = prepareChatRequest({}).headers.get(BROWSER_WORKSPACE_SCOPE_HEADER);
        window.history.replaceState({}, '', '/org/yo/chat');
        const second = prepareChatRequest({}).headers.get(BROWSER_WORKSPACE_SCOPE_HEADER);

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

        const { headers } = prepareChatRequest({
            headers: { [BROWSER_WORKSPACE_SCOPE_HEADER]: 'org:ever' },
        });

        expect(headers.get(BROWSER_WORKSPACE_SCOPE_HEADER)).toBe('org:yo');
    });
});
