import { describe, expect, it, vi } from 'vitest';
import type { TerminalFrame } from '@ever-works/contracts';
import { PtyLocalPlugin } from '@ever-works/pty-local-plugin';
import {
    MAX_CLI_SESSION_ID_LENGTH,
    TerminalSessionHost,
    normalizeCliSessionId,
} from './terminal-session-host';
import type { TerminalTransportClient } from './terminal-transport.client';

const RUN = '2f9d1f2a-9c7e-4b1a-8f0d-0a1b2c3d4e5f';
const NODE = process.execPath;

/**
 * Loopback harness: a REAL PtyLocalPlugin hosting REAL child processes,
 * with the transport + internal-API client replaced by in-memory sinks
 * — the complete worker-side byte path with no network and no SDK.
 */
function makeLoopbackClient() {
    const published: TerminalFrame[] = [];
    const heartbeats: Array<Record<string, unknown>> = [];
    const client = {
        heartbeat: vi.fn(async (_runId: string, body: Record<string, unknown>) => {
            heartbeats.push(body);
        }),
        createTransport: vi.fn(async () => ({
            publish: (frame: TerminalFrame) => {
                published.push(frame);
            },
            inbound: () => ({
                [Symbol.asyncIterator]() {
                    return {
                        next: () =>
                            new Promise<IteratorResult<TerminalFrame>>(() => {
                                // never yields — sessions in these tests end
                                // by process exit, not by input close
                            }),
                    };
                },
            }),
            close: async () => undefined,
        })),
        publishExit: vi.fn(async () => undefined),
    };
    return { client: client as unknown as TerminalTransportClient, published, heartbeats };
}

describe('TerminalSessionHost (loopback, real processes)', () => {
    it('runs the full lifecycle: starting → attached → heartbeats → ended/completed', async () => {
        const { client, published, heartbeats } = makeLoopbackClient();
        const host = new TerminalSessionHost(new PtyLocalPlugin(), client, 50);

        const result = await host.run({
            runId: RUN,
            command: [NODE, '-e', 'process.stdout.write("session-bytes")'],
            cwd: process.cwd(),
            env: {},
            persistent: true,
        });

        expect(result.reason).toBe('completed');

        // Lifecycle order: starting (with provider + persistent), attached, ended.
        expect(heartbeats[0]).toMatchObject({
            state: 'starting',
            providerId: 'pty-local',
            persistent: true,
        });
        expect(heartbeats[1]).toMatchObject({ state: 'attached' });
        expect(heartbeats[heartbeats.length - 1]).toMatchObject({
            state: 'ended',
            endedReason: 'completed',
        });

        // Preamble banner first; bytes present; exit pinned last.
        expect(published[0]).toMatchObject({ kind: 'error' });
        const stdout = published
            .filter((f): f is Extract<TerminalFrame, { kind: 'stdout' }> => f.kind === 'stdout')
            .map((f) => Buffer.from(f.data, 'base64').toString('utf8'))
            .join('');
        expect(stdout).toContain('session-bytes');
        expect(published[published.length - 1]).toMatchObject({ kind: 'exit' });
    });

    it('a crashing command still ends the lifecycle honestly (ended/crashed)', async () => {
        const { client, heartbeats } = makeLoopbackClient();
        const host = new TerminalSessionHost(new PtyLocalPlugin(), client, 50);

        const result = await host.run({
            runId: RUN,
            command: [NODE, '-e', 'process.exit(7)'],
            cwd: process.cwd(),
            env: {},
        });

        expect(result.reason).toBe('crashed');
        expect(heartbeats[heartbeats.length - 1]).toMatchObject({
            state: 'ended',
            endedReason: 'crashed',
        });
    });

    it('spawn failure publishes banner + crashed exit and rethrows (never a black pane)', async () => {
        const { client, published } = makeLoopbackClient();
        const failing = {
            providerName: 'exploding',
            capabilities: ['terminal-stream'],
            id: 'exploding',
            spawn: vi.fn(async () => {
                throw new Error('no runtime here');
            }),
        };
        const host = new TerminalSessionHost(failing as never, client, 50);

        await expect(
            host.run({ runId: RUN, command: ['whatever'], cwd: '/', env: {} }),
        ).rejects.toThrow('no runtime here');

        const kinds = published.map((f) => f.kind);
        expect(kinds).toContain('error');
        expect(published[published.length - 1]).toMatchObject({
            kind: 'exit',
            reason: 'crashed',
        });
    });

    /**
     * `cliSessionId` is the run's resume key. It had a column, an API
     * whitelist entry and a presence-only status field — and no writer
     * anywhere, so it was permanently null. The session host is where a
     * session comes into existence, so it is where the key is written.
     */
    it('writes the provider-minted session id on the attached beat', async () => {
        const { client, heartbeats } = makeLoopbackClient();
        const host = new TerminalSessionHost(new PtyLocalPlugin(), client, 5000);

        await host.run({
            runId: RUN,
            command: [NODE, '-e', 'process.stdout.write("x")'],
            cwd: process.cwd(),
            env: {},
        });

        const attached = heartbeats.find((h) => h.state === 'attached');
        expect(attached).toBeDefined();
        expect(typeof attached?.cliSessionId).toBe('string');
        expect(String(attached?.cliSessionId)).toMatch(new RegExp(`^pty-local:${RUN}:`));
        expect(String(attached?.cliSessionId).length).toBeLessThanOrEqual(
            MAX_CLI_SESSION_ID_LENGTH,
        );

        // The `starting` beat cannot know it yet — the provider mints it
        // during spawn — so it must not pretend to.
        expect(heartbeats[0]).not.toHaveProperty('cliSessionId');
    });

    it('sends NO cliSessionId when the provider mints none', async () => {
        const { client, heartbeats } = makeLoopbackClient();
        const sessionless = {
            providerName: 'sessionless',
            spawn: vi.fn(async () => ({
                runId: RUN,
                isPty: false,
                write: () => undefined,
                resize: () => undefined,
                kill: () => undefined,
                exited: Promise.resolve({ code: 0, reason: 'completed' as const }),
            })),
        };
        const host = new TerminalSessionHost(sessionless as never, client, 5000);

        await host.run({ runId: RUN, command: ['/bin/true'], cwd: '/', env: {} });

        const attached = heartbeats.find((h) => h.state === 'attached');
        expect(attached).toEqual({ state: 'attached' });
    });

    it('heartbeats repeat while the session lives', async () => {
        const { client, heartbeats } = makeLoopbackClient();
        const host = new TerminalSessionHost(new PtyLocalPlugin(), client, 40);

        await host.run({
            runId: RUN,
            // Live ~350ms so several 40ms beats land.
            command: [NODE, '-e', 'setTimeout(()=>{},350)'],
            cwd: process.cwd(),
            env: {},
        });

        const attachedBeats = heartbeats.filter((h) => h.state === 'attached').length;
        expect(attachedBeats).toBeGreaterThanOrEqual(3);
    });
});

describe('normalizeCliSessionId', () => {
    it('accepts a trimmed non-empty id within the API whitelist cap', () => {
        expect(normalizeCliSessionId('  pty-local:run:42  ')).toBe('pty-local:run:42');
        expect(normalizeCliSessionId('x'.repeat(MAX_CLI_SESSION_ID_LENGTH))).toHaveLength(
            MAX_CLI_SESSION_ID_LENGTH,
        );
    });

    it('rejects anything the API would silently drop — never truncates', () => {
        // A truncated resume key is worse than an absent one: it looks
        // present (hasCliSession: true) and resolves to nothing.
        expect(normalizeCliSessionId('x'.repeat(MAX_CLI_SESSION_ID_LENGTH + 1))).toBeNull();
        expect(normalizeCliSessionId('   ')).toBeNull();
        expect(normalizeCliSessionId(undefined)).toBeNull();
        expect(normalizeCliSessionId(42)).toBeNull();
    });
});
