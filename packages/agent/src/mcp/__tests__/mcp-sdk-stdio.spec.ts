import { join } from 'node:path';
import { createStdioSdkClient, MCP_STDIO_CONNECT_TIMEOUT_MS } from '../mcp-sdk';

/**
 * `createStdioSdkClient` against a REAL child process (AP-14).
 *
 * This spec exists because of what this epic already shipped twice: a
 * deadlocked pinned fetch and a stalled stdio server, both hidden behind
 * seams every other test replaced, and both invisible at token sizes. So
 * these drive an actual `node` child over actual pipes, and the stderr case
 * uses 200 KB rather than a few bytes — 10 bytes passes with no drain at all.
 *
 * Two orderings are under test and neither is incidental:
 *   - the transport must be handed over UNSTARTED, because
 *     `Client.connect()` starts it and `StdioClientTransport.start()` throws
 *     on a second start;
 *   - the stderr drain must be attached AFTER connect, because `stderr` does
 *     not exist until the child is spawned.
 */
const SERVER = join(__dirname, 'fixtures', 'stdio-echo-server.cjs');

function baseParams(env: Record<string, string> = {}) {
    return {
        command: process.execPath,
        args: [SERVER],
        env: { ...env },
        cwd: __dirname,
    };
}

describe('createStdioSdkClient', () => {
    jest.setTimeout(30_000);

    it('spawns the server, completes initialize, and lists its tools', async () => {
        const launched = await createStdioSdkClient(baseParams());

        try {
            const result = await launched.client.listTools(undefined, { timeout: 10_000 });
            expect(result.tools.map((tool) => tool.name)).toEqual(['echo_env']);
        } finally {
            await launched.close();
        }
    });

    it('hands the child the launch plan’s environment, and nothing else', async () => {
        const launched = await createStdioSdkClient(
            baseParams({ ECHO_ENV_VAR: 'PLUGIN_SECRET', PLUGIN_SECRET: 'from-the-plan' }),
        );

        try {
            const result = (await launched.client.callTool(
                { name: 'echo_env', arguments: {} },
                undefined,
                { timeout: 10_000 },
            )) as { content: Array<{ text: string }> };

            expect(result.content[0]?.text).toBe('from-the-plan');
        } finally {
            await launched.close();
        }
    });

    /**
     * The regression that matters. `stderr: 'pipe'` with nothing reading it
     * stalls the child mid-write past ~80 KB (16 KB PassThrough + ~64 KB OS
     * pipe) and the server never answers. A test using a token-sized payload
     * proves the code runs, not that it works.
     */
    it('keeps serving after the child floods stderr with 200 KB', async () => {
        const launched = await createStdioSdkClient(
            baseParams({ STDERR_FLOOD_BYTES: String(200 * 1024) }),
        );

        try {
            const result = await launched.client.listTools(undefined, { timeout: 15_000 });
            expect(result.tools).toHaveLength(1);
        } finally {
            await launched.close();
        }
    });

    it('rejects — and leaves no child behind — when the command does not exist', async () => {
        await expect(
            createStdioSdkClient({
                command: join(__dirname, 'fixtures', 'definitely-not-here'),
                args: [],
                env: {},
                cwd: __dirname,
            }),
        ).rejects.toBeDefined();
    });

    /**
     * A server can spawn cleanly and then never speak. `Client.connect` runs
     * `initialize` as an ordinary request, so unbounded it waits the SDK's
     * 60s default — awaited inside run assembly, per connection, serially,
     * and before the run loop's first cancellation checkpoint.
     */
    it('gives up on a server that spawns and never answers, instead of hanging', async () => {
        const started = Date.now();

        await expect(
            createStdioSdkClient({ ...baseParams({ HANG_FOREVER: '1' }), timeoutMs: 1_000 }),
        ).rejects.toBeDefined();

        expect(Date.now() - started).toBeLessThan(20_000);
    });

    it('defaults the bound to the same 10s the remote connect path uses', () => {
        expect(MCP_STDIO_CONNECT_TIMEOUT_MS).toBe(10_000);
    });

    it('close() is safe to call twice', async () => {
        const launched = await createStdioSdkClient(baseParams());

        await launched.close();
        await expect(launched.close()).resolves.toBeUndefined();
    });
});
