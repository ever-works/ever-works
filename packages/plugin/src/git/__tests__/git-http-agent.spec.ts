import { describe, it, expect, afterAll } from 'vitest';
import * as nodeHttp from 'isomorphic-git/http/node';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { http } from '../git-operations.js';

/**
 * Regression cover for the generation-killing git timeout.
 *
 * Node >= 19 gives `http(s).globalAgent` a `timeout: 5000` SOCKET-IDLE deadline. `isomorphic-git`'s node
 * HTTP client passes no `agent`, so it inherits that deadline and `simple-get` rejects with the literal
 * string `Request timed out` — which the push retry list does not match, so a whole generation dies.
 *
 * The control below is the important half: it asserts the RAW client still fails at ~5s. Without it a
 * green subject test would prove nothing (it would pass just as well if the server were fast).
 */

const SERVER_DELAY_MS = 8_000;
const TEST_TIMEOUT_MS = 30_000;

// Every started server is tracked so afterAll can close ALL of them. Tracking a single handle would
// leak the first server (each test starts its own), which can keep the vitest process alive in CI.
const servers: Server[] = [];

function startSlowServer(): Promise<string> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			// Drain the request body, then deliberately stay silent past the 5s global-agent deadline.
			req.resume();
			req.on('end', () => {
				setTimeout(() => {
					res.writeHead(200, { 'Content-Type': 'text/plain' });
					res.end('ok');
				}, SERVER_DELAY_MS);
			});
		});
		servers.push(server);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}/slow`);
		});
	});
}

afterAll(async () => {
	await Promise.all(
		servers.map(
			(s) =>
				new Promise<void>((resolve) => {
					s.close(() => resolve());
				})
		)
	);
});

describe('git HTTP client agent timeout', () => {
	it(
		'CONTROL: the raw isomorphic-git client inherits the 5s global agent timeout and fails',
		async () => {
			// Guard the premise: if a future Node drops this default the control is meaningless, and this
			// assertion tells us so instead of the suite silently going green for the wrong reason.
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { globalAgent } = await import('node:https');
			expect(globalAgent.options.timeout).toBe(5000);

			const url = await startSlowServer();
			const started = Date.now();

			await expect(
				nodeHttp.request({ url, method: 'GET', headers: {} } as Parameters<typeof nodeHttp.request>[0])
			).rejects.toThrow(/timed out/i);

			const elapsed = Date.now() - started;
			expect(elapsed).toBeLessThan(SERVER_DELAY_MS);
		},
		TEST_TIMEOUT_MS
	);

	it(
		'SUBJECT: the wrapped client supplies an agent and survives a slow server',
		async () => {
			const url = await startSlowServer();
			const started = Date.now();

			const response = await http.request({
				url,
				method: 'GET',
				headers: {}
			} as Parameters<typeof nodeHttp.request>[0]);

			expect(response.statusCode).toBe(200);
			// It really did wait out the slow server rather than short-circuiting.
			expect(Date.now() - started).toBeGreaterThanOrEqual(SERVER_DELAY_MS - 500);
		},
		TEST_TIMEOUT_MS
	);
});
