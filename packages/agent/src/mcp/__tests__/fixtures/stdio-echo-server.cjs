#!/usr/bin/env node
/**
 * A minimal REAL MCP server over stdio, for `createStdioSdkClient`'s spec.
 *
 * Newline-delimited JSON-RPC 2.0 on stdin/stdout — enough of the protocol to
 * complete `initialize` and answer `tools/list` / `tools/call`.
 *
 * Why a real child rather than a stub: the two production hangs this epic
 * already shipped (the undici dispatcher deadlock and the stderr backpressure
 * stall) both hid behind seams that every test replaced. They were also both
 * SIZE-dependent — 10 bytes passed, 200 KB hung. So this fixture can be told
 * to flood stderr, and the spec asserts the client still answers afterwards.
 *
 * Env:
 *   STDERR_FLOOD_BYTES  write this many bytes to stderr before serving.
 *   ECHO_ENV_VAR        name of an env var whose value is returned by the
 *                       `echo_env` tool, so the spec can prove the launch
 *                       plan's environment actually reached the process.
 */
'use strict';

const floodBytes = Number(process.env.STDERR_FLOOD_BYTES || 0);
if (floodBytes > 0) {
    // One big write. Without a reader draining the pipe this stalls the
    // process partway through and nothing below ever runs.
    process.stderr.write('x'.repeat(floodBytes));
}

// A server that spawns cleanly and then never speaks. Without a bound on the
// initialize handshake the client waits the SDK's 60s default for this.
if (process.env.HANG_FOREVER === '1') {
    process.stdin.resume();
    setInterval(() => undefined, 1 << 30);
} else {
    const TOOLS = [
        {
            name: 'echo_env',
            description: 'Return the value of the configured environment variable.',
            inputSchema: { type: 'object', properties: {}, required: [] },
        },
    ];

    function send(message) {
        process.stdout.write(JSON.stringify(message) + '\n');
    }

    let buffer = '';
    process.stdin.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let cut;
        while ((cut = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, cut).trim();
            buffer = buffer.slice(cut + 1);
            if (!line) continue;

            let request;
            try {
                request = JSON.parse(line);
            } catch {
                continue;
            }

            // Notifications carry no id and expect no reply.
            if (request.id === undefined) continue;

            if (request.method === 'initialize') {
                send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        // Echo the client's requested version: the SDK rejects a
                        // version it did not ask for.
                        protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'stdio-echo-server', version: '1.0.0' },
                    },
                });
            } else if (request.method === 'tools/list') {
                send({ jsonrpc: '2.0', id: request.id, result: { tools: TOOLS } });
            } else if (request.method === 'tools/call') {
                const varName = process.env.ECHO_ENV_VAR || '';
                send({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        content: [{ type: 'text', text: String(process.env[varName] ?? '') }],
                    },
                });
            } else {
                send({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: { code: -32601, message: `Unknown method ${request.method}` },
                });
            }
        }
    });
} // end of the non-hanging server
