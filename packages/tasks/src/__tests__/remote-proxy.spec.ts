import { describe, it, expect, vi } from 'vitest';
import superjson from 'superjson';

import { createRemoteProxy } from '../trigger/worker/remote-proxy';
import type { TriggerInternalApiClient } from '../trigger/worker/services/trigger-internal-api.client';

/** A stub client that records the SuperJSON envelope the proxy produced. */
const makeClient = () => {
    const callRemote = vi.fn().mockResolvedValue(undefined);
    return {
        client: { callRemote } as unknown as TriggerInternalApiClient,
        callRemote,
        /** The args as the API would see them after deserialization. */
        received: () => superjson.deserialize(callRemote.mock.calls[0][2]) as unknown[],
    };
};

describe('createRemoteProxy', () => {
    it('forwards the method name and provider to the client', async () => {
        const { client, callRemote } = makeClient();
        await createRemoteProxy(client, 'SomeService').doThing({ a: 1 });

        expect(callRemote).toHaveBeenCalledTimes(1);
        expect(callRemote.mock.calls[0][0]).toBe('SomeService');
        expect(callRemote.mock.calls[0][1]).toBe('doThing');
    });

    it('runs localMethods locally instead of forwarding them', async () => {
        const { client, callRemote } = makeClient();
        const local = { stayHere: () => 'local-result' };

        const proxy = createRemoteProxy(client, 'SomeService', local);

        expect(proxy.stayHere()).toBe('local-result');
        expect(callRemote).not.toHaveBeenCalled();
    });

    describe('AbortSignal stripping', () => {
        /**
         * SuperJSON has no transformer for AbortSignal: it encodes to `{}` and
         * arrives API-side as a truthy object whose `.aborted` is `undefined`.
         * That is strictly worse than sending nothing, because downstream
         * `if (signal) signal.addEventListener(...)` then throws. Dropping it
         * restores the honest shape.
         */
        it('drops a signal nested in an options bag', async () => {
            const { client, received } = makeClient();
            const controller = new AbortController();

            await createRemoteProxy(client, 'AgentRunService').execute({
                runId: 'r1',
                signal: controller.signal,
            });

            const [options] = received() as [Record<string, unknown>];
            expect(options).toEqual({ runId: 'r1' });
            expect('signal' in options).toBe(false);
        });

        it('drops a signal passed as a bare positional argument', async () => {
            const { client, received } = makeClient();
            const controller = new AbortController();

            await createRemoteProxy(client, 'S').m('keep-me', controller.signal);

            expect(received()).toEqual(['keep-me', undefined]);
        });

        it('drops an ALREADY-ABORTED signal too — the aborted state does not survive either', async () => {
            const { client, received } = makeClient();
            const controller = new AbortController();
            controller.abort();

            await createRemoteProxy(client, 'S').m({ signal: controller.signal });

            expect(received()).toEqual([{}]);
        });

        it('drops a signal nested deeper than the top level', async () => {
            const { client, received } = makeClient();
            const controller = new AbortController();

            await createRemoteProxy(client, 'S').m({
                outer: { inner: { signal: controller.signal, keep: true } },
            });

            expect(received()).toEqual([{ outer: { inner: { keep: true } } }]);
        });

        it('does not mutate the caller-supplied argument object', async () => {
            const { client } = makeClient();
            const controller = new AbortController();
            const options = { runId: 'r1', signal: controller.signal };

            await createRemoteProxy(client, 'S').m(options);

            expect(options.signal).toBe(controller.signal);
        });
    });

    describe('rich-type preservation', () => {
        // The stripper rebuilds plain containers only. Rebuilding a Date/Map/Set
        // would flatten it to a bare object and silently break the SuperJSON
        // round-trip this proxy exists to provide.
        it('preserves Date, Map and Set through the envelope', async () => {
            const { client, received } = makeClient();
            const when = new Date('2026-01-01T00:00:00.000Z');
            const map = new Map([['k', 'v']]);
            const set = new Set([1, 2]);

            await createRemoteProxy(client, 'S').m({ when, map, set });

            const [payload] = received() as [
                { when: Date; map: Map<string, string>; set: Set<number> },
            ];
            expect(payload.when).toBeInstanceOf(Date);
            expect(payload.when.toISOString()).toBe('2026-01-01T00:00:00.000Z');
            expect(payload.map).toBeInstanceOf(Map);
            expect(payload.map.get('k')).toBe('v');
            expect(payload.set).toBeInstanceOf(Set);
            expect(payload.set.has(2)).toBe(true);
        });

        it('preserves a Date sitting alongside a stripped signal', async () => {
            const { client, received } = makeClient();
            const controller = new AbortController();

            await createRemoteProxy(client, 'S').m({
                when: new Date('2026-06-01T12:00:00.000Z'),
                signal: controller.signal,
            });

            const [payload] = received() as [{ when: Date; signal?: unknown }];
            expect(payload.when).toBeInstanceOf(Date);
            expect(payload.signal).toBeUndefined();
        });

        it('leaves ordinary values untouched', async () => {
            const { client, received } = makeClient();

            await createRemoteProxy(client, 'S').m('a', 1, null, [1, { b: 2 }], { c: [3] });

            expect(received()).toEqual(['a', 1, null, [1, { b: 2 }], { c: [3] }]);
        });
    });
});
