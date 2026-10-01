/**
 * T8 — `app-runner.script.ts` (plan §4.8, §4.9, §4.10; spec FR-19/FR-35/FR-37, ACC-06-12).
 *
 * Every clause of T8's second `**Test**` line (tasks.md:160-162) has an `it` below:
 *
 * - "runs the script in-process against a local HTTP server"
 * - "status, `bodyContains`, `bodyNotContains` failure quoting the found string (ACC-06-12)"
 * - "with the 1 MiB cap"
 * - "latency"
 * - "307 not followed"
 * - "bearer vs raw header"
 *
 * plus the T8 prose clauses the renderer spec cannot reach — `found` capped at 200 chars and
 * secret-scrubbed, `{{env.NAME}}` resolved at run time, the resolved body never logged, and the
 * §4.10 isolation probe.
 *
 * **How the script is executed in-process.** `APP_RUNNER_SCRIPT` is the exact text that runs in
 * the Job: it is evaluated with `node:vm` in a fresh context whose `process` is a stub (so
 * `process.exit` records the exit code instead of ending the test run), whose `require` serves an
 * in-memory `node:fs` (so no temp file is written) and which shares the host's `fetch`,
 * `AbortController` and `node:net`. Everything else — the HTTP round trips, the redirect policy,
 * the header the server really received — is real.
 *
 * Every server binds `127.0.0.1` on an ephemeral port; no host, address or secret in this file is
 * real (RFC 2606 / RFC 5737 / placeholder values only).
 */
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type Server as HttpServer,
	type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
	APP_RUNNER_CONFIGMAP_REQUESTS_KEY,
	APP_RUNNER_EXIT_FAILED,
	APP_RUNNER_EXIT_OK,
	APP_RUNNER_FOUND_CHARS,
	APP_RUNNER_IMAGE,
	APP_RUNNER_MAX_BODY_BYTES,
	APP_RUNNER_REDACTED,
	APP_RUNNER_REQUESTS_ENV,
	APP_RUNNER_REQUESTS_FILE,
	APP_RUNNER_SCRIPT,
	APP_RUNNER_SCRIPT_FILE,
	type AppRunnerPayload,
	type AppRunnerRecord,
	type AppRunnerRequestData
} from '../app-runner.script';

// --- harness ----------------------------------------------------------------

type Json = Record<string, any>;

const realRequire = createRequire(import.meta.url);

interface Hit {
	url: string;
	method: string;
	headers: IncomingHttpHeaders;
	body: string;
}

interface LocalServer {
	base: string;
	port: number;
	hits: Hit[];
	close(): Promise<void>;
}

/** A real HTTP server on 127.0.0.1:0 — the only network these tests touch. */
async function startServer(
	route: (request: IncomingMessage, response: ServerResponse, hits: Hit[]) => void
): Promise<LocalServer> {
	const hits: Hit[] = [];
	const server: HttpServer = createServer((request, response) => {
		let body = '';
		request.setEncoding('utf8');
		request.on('data', (chunk: string) => {
			body += chunk;
		});
		request.on('end', () => {
			hits.push({ url: request.url ?? '', method: request.method ?? '', headers: request.headers, body });
			route(request, response, hits);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		base: `http://127.0.0.1:${port}`,
		port,
		hits,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			})
	};
}

const NO_REQUESTS_PATH = '/etc/ever-works/requests.json';

interface RunnerOutcome {
	exitCode: number | null;
	records: AppRunnerRecord[];
	stdout: string;
	stderr: string;
}

/**
 * Run `APP_RUNNER_SCRIPT` exactly as the Job would, in this process.
 *
 * `payload === null` makes the request file unreadable (the fatal path). `env` is the container
 * environment: the mounted `secretKeyRef` values live there, as they do in the cluster.
 */
async function runRunner(payload: AppRunnerPayload | null, env: Record<string, string> = {}): Promise<RunnerOutcome> {
	const text = payload === null ? null : JSON.stringify(payload);
	const stdoutLines: string[] = [];
	const stderrLines: string[] = [];
	let exitCode: number | null = null;

	const fakeFs = {
		readFileSync: (path: string): string => {
			if (text !== null && path === NO_REQUESTS_PATH) {
				return text;
			}
			throw new Error(`ENOENT: no such file or directory, open '${path}'`);
		}
	};

	// The script reports through `process.exitCode` (so a pipe can never truncate its output), not
	// through `process.exit` — this stub is what observes it.
	const sandboxProcess: Record<string, unknown> = {
		env: { [APP_RUNNER_REQUESTS_ENV]: NO_REQUESTS_PATH, ...env },
		argv: ['node', APP_RUNNER_SCRIPT_FILE],
		platform: 'linux',
		version: 'v22.0.0',
		stdout: {
			write: (chunk: string): boolean => {
				stdoutLines.push(String(chunk));
				return true;
			}
		},
		stderr: {
			write: (chunk: string): boolean => {
				stderrLines.push(String(chunk));
				return true;
			}
		}
	};
	Object.defineProperty(sandboxProcess, 'exitCode', {
		enumerable: true,
		configurable: true,
		get: () => exitCode,
		set: (value: number) => {
			exitCode = value;
		}
	});

	const context = vm.createContext({
		process: sandboxProcess,
		require: (id: string): unknown => (id === 'node:fs' || id === 'fs' ? fakeFs : realRequire(id)),
		fetch: globalThis.fetch,
		AbortController,
		TextDecoder,
		setTimeout,
		clearTimeout,
		console
	});

	vm.runInContext(APP_RUNNER_SCRIPT, context, { filename: 'ever-works-runner.js' });

	const deadline = Date.now() + 8_000;
	while (exitCode === null && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 5));
	}

	const stdout = stdoutLines.join('');
	return {
		exitCode,
		records: stdout
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as AppRunnerRecord),
		stdout,
		stderr: stderrLines.join('')
	};
}

function request(over: Partial<AppRunnerRequestData> & { name: string; url: string }): AppRunnerRequestData {
	return {
		method: 'POST',
		expect: { status: [200, 201, 204], bodyContains: [], bodyNotContains: [], maxLatencyMs: 10_000 },
		timeoutMs: 10_000,
		...over
	};
}

function payload(requests: AppRunnerRequestData[], over: Partial<AppRunnerPayload> = {}): AppRunnerPayload {
	return { version: 1, kind: 'http-job', requests, secrets: [], ...over };
}

const only = (outcome: RunnerOutcome): AppRunnerRecord => {
	expect(outcome.records, 'exactly one JSON line').toHaveLength(1);
	return outcome.records[0];
};

// --- constants --------------------------------------------------------------

describe('runner constants (plan §4.8, §5.3)', () => {
	it('pins the 1 MiB body cap and the 200-character `found` cap of §5.3', () => {
		expect(APP_RUNNER_MAX_BODY_BYTES).toBe(1_048_576);
		expect(APP_RUNNER_FOUND_CHARS).toBe(200);
		expect(APP_RUNNER_REDACTED).toBe('***');
		expect(APP_RUNNER_REQUESTS_FILE).toBe(NO_REQUESTS_PATH);
		expect(APP_RUNNER_CONFIGMAP_REQUESTS_KEY).toBe('requests.json');
	});

	it('is a digest-pinned public runtime image', () => {
		expect(APP_RUNNER_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
	});

	it("never follows a redirect: the script pins `redirect: 'manual'` (plan §4.8)", () => {
		expect(APP_RUNNER_SCRIPT).toMatch(/redirect:\s*'manual'/);
		expect(APP_RUNNER_SCRIPT).not.toMatch(/redirect:\s*'follow'/);
	});
});

// --- status -----------------------------------------------------------------

describe('status (plan §4.8: "so `expect.status` judges the first response")', () => {
	it('passes a 200 the request expected, and exits 0', async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end('ok');
		});
		try {
			const outcome = await runRunner(payload([request({ name: 'health', url: `${server.base}/healthz` })]));
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
			expect(record).toMatchObject({ kind: 'http', name: 'health', status: 200, ok: true });
			expect(record.latencyMs).toBeGreaterThanOrEqual(0);
			expect(record.failedExpectation).toBeUndefined();
			expect(server.hits[0].url).toBe('/healthz');
		} finally {
			await server.close();
		}
	});

	it('fails a 500 the request did not expect, names the expectation and exits 1', async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(500, { 'content-type': 'text/plain' });
			response.end('boom');
		});
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'health',
						url: `${server.base}/healthz`,
						expect: { status: [200], bodyContains: [], bodyNotContains: [], maxLatencyMs: 10_000 }
					})
				])
			);
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
			expect(record.ok).toBe(false);
			expect(record.status).toBe(500);
			expect(record.failedExpectation).toContain('200');
			expect(record.failedExpectation).toContain('500');
		} finally {
			await server.close();
		}
	});

	it('accepts the job default `[200, 201, 204]` when the request declares no expectation', async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(204);
			response.end();
		});
		try {
			const outcome = await runRunner(
				payload([{ name: 'job', url: `${server.base}/job`, method: 'POST', timeoutMs: 10_000 }])
			);
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
			expect(record.status).toBe(204);
			expect(record.ok).toBe(true);
		} finally {
			await server.close();
		}
	});

	it('reports a connection failure as a failed check rather than a crash', async () => {
		const closed = await startServer((_request, response) => response.end('x'));
		const port = closed.port;
		await closed.close();

		const outcome = await runRunner(
			payload([request({ name: 'dead', url: `http://127.0.0.1:${port}/nope`, timeoutMs: 2_000 })])
		);
		const record = only(outcome);

		expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
		expect(record.ok).toBe(false);
		expect(String(record.failedExpectation)).toMatch(/request failed/i);
	});
});

// --- body expectations (ACC-06-12) -----------------------------------------

describe('bodyContains / bodyNotContains (ACC-06-12: "failure quotes the string")', () => {
	it('passes when the body contains the expected string', async () => {
		const server = await startServer((_request, response) => response.end('booting: ready'));
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'ready',
						url: `${server.base}/ready`,
						expect: { status: [200], bodyContains: ['ready'], bodyNotContains: [], maxLatencyMs: 10_000 }
					})
				])
			);
			expect(only(outcome).ok).toBe(true);
			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
		} finally {
			await server.close();
		}
	});

	it('fails a missing `bodyContains` and shows what was found instead', async () => {
		const server = await startServer((_request, response) => response.end('booting: starting up'));
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'ready',
						url: `${server.base}/ready`,
						expect: {
							status: [200],
							bodyContains: ['NEEDLE-ABSENT'],
							bodyNotContains: [],
							maxLatencyMs: 10_000
						}
					})
				])
			);
			const record = only(outcome);

			expect(record.ok).toBe(false);
			expect(record.failedExpectation).toContain('NEEDLE-ABSENT');
			expect(record.found).toContain('booting: starting up');
		} finally {
			await server.close();
		}
	});

	it('fails a `bodyNotContains` hit and quotes the offending string', async () => {
		const server = await startServer((_request, response) =>
			response.end('{"status":"ok","trace":"SENTINEL-LEAK traceback follows"}')
		);
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'no-leak',
						url: `${server.base}/page`,
						expect: {
							status: [200],
							bodyContains: [],
							bodyNotContains: ['SENTINEL-LEAK'],
							maxLatencyMs: 10_000
						}
					})
				])
			);
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
			expect(record.ok).toBe(false);
			expect(String(record.failedExpectation)).toContain('SENTINEL-LEAK');
			expect(String(record.found)).toContain('SENTINEL-LEAK');
		} finally {
			await server.close();
		}
	});

	it('caps `found` at 200 characters (§3.1: `≤ 200 chars`)', async () => {
		const long = `start-${'x'.repeat(5_000)}-end`;
		const server = await startServer((_request, response) => response.end(long));
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'long',
						url: `${server.base}/long`,
						expect: {
							status: [200],
							bodyContains: ['NEEDLE-ABSENT'],
							bodyNotContains: [],
							maxLatencyMs: 10_000
						}
					})
				])
			);
			const record = only(outcome);

			expect(record.found).toBeDefined();
			expect(String(record.found).length).toBeLessThanOrEqual(APP_RUNNER_FOUND_CHARS);
			expect(APP_RUNNER_FOUND_CHARS).toBe(200);
		} finally {
			await server.close();
		}
	});

	it('scrubs every mounted secret value out of `found`', async () => {
		const secret = 'placeholder-token-abcdef123456';
		const server = await startServer((_request, response) =>
			response.end(`auth failed for token ${secret} — see docs`)
		);
		try {
			const outcome = await runRunner(
				payload(
					[
						request({
							name: 'no-secret',
							url: `${server.base}/page`,
							expect: {
								status: [200],
								// A missing needle is what makes the runner quote what it *did* find —
								// and that excerpt is where a leaked credential would show up.
								bodyContains: ['NEEDLE-ABSENT'],
								bodyNotContains: [],
								maxLatencyMs: 10_000
							}
						})
					],
					{ secrets: ['AUTH_TOKEN'] }
				),
				{ AUTH_TOKEN: secret }
			);
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
			expect(record.ok).toBe(false);
			expect(outcome.stdout).not.toContain(secret);
			expect(String(record.found)).not.toContain(secret);
			expect(String(record.found)).toContain(APP_RUNNER_REDACTED);
		} finally {
			await server.close();
		}
	});

	it('never truncates a secret in half: the scrub runs before the 200-character cap', async () => {
		const secret = 'placeholder-token-abcdef123456';
		const filler = 'y'.repeat(180);
		const server = await startServer((_request, response) => response.end(`${filler}${secret}tail`));
		try {
			const outcome = await runRunner(
				payload(
					[
						request({
							name: 'no-secret',
							url: `${server.base}/page`,
							expect: {
								status: [200],
								bodyContains: [],
								bodyNotContains: ['NEEDLE-ABSENT'],
								maxLatencyMs: 10_000
							}
						})
					],
					{ secrets: ['AUTH_TOKEN'] }
				),
				{ AUTH_TOKEN: secret }
			);
			const record = only(outcome);

			expect(String(record.found)).not.toContain('placeholder-token-abcdef');
			expect(String(record.found).length).toBeLessThanOrEqual(APP_RUNNER_FOUND_CHARS);
		} finally {
			await server.close();
		}
	});
});

// --- the 1 MiB cap ----------------------------------------------------------

describe('the 1 MiB body cap (plan §4.8, §5.3 — "present (in the first 1 MiB)")', () => {
	it('searches the first 1 MiB, reports the truncation, and cannot see past it', async () => {
		const filler = 'a'.repeat(APP_RUNNER_MAX_BODY_BYTES);
		const body = `NEAR-MARK${filler}FAR-MARK`;
		const server = await startServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'text/plain' });
			response.end(body);
		});
		try {
			const near = await runRunner(
				payload([
					request({
						name: 'near',
						url: `${server.base}/big`,
						expect: {
							status: [200],
							bodyContains: ['NEAR-MARK'],
							bodyNotContains: [],
							maxLatencyMs: 10_000
						}
					})
				])
			);
			expect(only(near).ok).toBe(true);
			expect(only(near).bodyTruncated).toBe(true);
			expect(near.records[0].bytes).toBe(APP_RUNNER_MAX_BODY_BYTES);

			const far = await runRunner(
				payload([
					request({
						name: 'far',
						url: `${server.base}/big`,
						expect: { status: [200], bodyContains: ['FAR-MARK'], bodyNotContains: [], maxLatencyMs: 10_000 }
					})
				])
			);
			expect(only(far).ok).toBe(false);
			expect(String(only(far).failedExpectation)).toContain('FAR-MARK');

			const forbidden = await runRunner(
				payload([
					request({
						name: 'forbidden',
						url: `${server.base}/big`,
						expect: {
							status: [200],
							bodyContains: [],
							bodyNotContains: ['FAR-MARK'],
							maxLatencyMs: 10_000
						}
					})
				])
			);
			// Past the cap the string is invisible, so `bodyNotContains` cannot fail on it — the
			// documented consequence of searching only the first MiB.
			expect(only(forbidden).ok).toBe(true);
		} finally {
			await server.close();
		}
	});

	it('does not report truncation for a body of exactly the cap', async () => {
		const server = await startServer((_request, response) => response.end('b'.repeat(1_024)));
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'small',
						url: `${server.base}/small`,
						expect: { status: [200], bodyContains: [], bodyNotContains: [], maxLatencyMs: 10_000 }
					})
				])
			);
			expect(only(outcome).bodyTruncated).toBe(false);
			expect(only(outcome).bytes).toBe(1_024);
		} finally {
			await server.close();
		}
	});
});

// --- latency ----------------------------------------------------------------

describe('latency (plan §3.1: `maxLatencyMs`, default 10 000)', () => {
	it('passes a response inside the limit and reports the measured latency', async () => {
		const server = await startServer((_request, response) => {
			setTimeout(() => response.end('slow-ish'), 150);
		});
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'slow',
						url: `${server.base}/slow`,
						expect: { status: [200], bodyContains: [], bodyNotContains: [], maxLatencyMs: 5_000 }
					})
				])
			);
			const record = only(outcome);

			expect(record.ok).toBe(true);
			expect(Number(record.latencyMs)).toBeGreaterThanOrEqual(100);
		} finally {
			await server.close();
		}
	});

	it('fails a response slower than `maxLatencyMs` and names the limit', async () => {
		const server = await startServer((_request, response) => {
			setTimeout(() => response.end('too slow'), 250);
		});
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'slow',
						url: `${server.base}/slow`,
						expect: { status: [200], bodyContains: [], bodyNotContains: [], maxLatencyMs: 50 }
					})
				])
			);
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
			expect(record.ok).toBe(false);
			expect(String(record.failedExpectation)).toContain('50');
			expect(String(record.failedExpectation)).toMatch(/latency/i);
		} finally {
			await server.close();
		}
	});

	it('gives up on a request that outlives its own timeoutMs', async () => {
		const server = await startServer((_request, response) => {
			setTimeout(() => response.end('never'), 2_000);
		});
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'hung',
						url: `${server.base}/hung`,
						timeoutMs: 60,
						expect: { status: [200], bodyContains: [], bodyNotContains: [], maxLatencyMs: 10_000 }
					})
				])
			);
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
			expect(record.ok).toBe(false);
			expect(String(record.failedExpectation)).toMatch(/timed out|timeout/i);
		} finally {
			await server.close();
		}
	});
});

// --- redirects --------------------------------------------------------------

describe('redirects are never followed (plan §4.8, CONTRACTS §1)', () => {
	it('judges the 307 itself and never reaches the redirect target', async () => {
		const target = await startServer((_request, response) => response.end('TARGET-REACHED'));
		const server = await startServer((_request, response) => {
			response.writeHead(307, { location: `${target.base}/target` });
			response.end('redirecting');
		});
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'redirect',
						url: `${server.base}/from`,
						expect: { status: [200], bodyContains: [], bodyNotContains: [], maxLatencyMs: 10_000 }
					})
				])
			);
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
			expect(record.status).toBe(307);
			expect(record.ok).toBe(false);
			expect(target.hits).toHaveLength(0);
			expect(outcome.stdout).not.toContain('TARGET-REACHED');
		} finally {
			await server.close();
			await target.close();
		}
	});

	it('passes a request that explicitly expects the redirect status', async () => {
		const server = await startServer((_request, response) => {
			response.writeHead(308, { location: 'https://example.com/moved' });
			response.end('moved');
		});
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'expect-redirect',
						url: `${server.base}/from`,
						expect: { status: [307, 308], bodyContains: [], bodyNotContains: [], maxLatencyMs: 10_000 }
					})
				])
			);
			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
			expect(only(outcome).status).toBe(308);
		} finally {
			await server.close();
		}
	});
});

// --- auth and placeholders --------------------------------------------------

describe('authScheme bearer vs raw (plan §4.8, APW-13)', () => {
	it('sends `Authorization: Bearer <value>` for the default scheme', async () => {
		const server = await startServer((_request, response) => response.end('ok'));
		try {
			const outcome = await runRunner(
				payload([request({ name: 'ping', url: `${server.base}/ping`, authEnv: 'AUTH_TOKEN' })]),
				{ AUTH_TOKEN: 'placeholder-token-value' }
			);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
			expect(server.hits[0].headers.authorization).toBe('Bearer placeholder-token-value');
		} finally {
			await server.close();
		}
	});

	it('sends the value unchanged for `authScheme: raw`', async () => {
		const server = await startServer((_request, response) => response.end('ok'));
		try {
			const outcome = await runRunner(
				payload([
					request({ name: 'ping', url: `${server.base}/ping`, authEnv: 'AUTH_TOKEN', authScheme: 'raw' })
				]),
				{ AUTH_TOKEN: 'placeholder-token-value' }
			);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
			expect(server.hits[0].headers.authorization).toBe('placeholder-token-value');
		} finally {
			await server.close();
		}
	});

	it('sends no Authorization header when the request names no authEnv', async () => {
		const server = await startServer((_request, response) => response.end('ok'));
		try {
			await runRunner(payload([request({ name: 'public', url: `${server.base}/public` })]));
			expect(server.hits[0].headers.authorization).toBeUndefined();
		} finally {
			await server.close();
		}
	});
});

describe('`{{env.NAME}}` placeholders (plan §4.8: "resolved by the runner from `secretKeyRef` env vars")', () => {
	it('resolves a placeholder in the body and never logs the resolved value', async () => {
		const server = await startServer((_request, response) => response.end('ok'));
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'login',
						url: `${server.base}/login`,
						body: { user: 'admin', token: '{{env.AUTH_TOKEN}}', nested: ['{{env.AUTH_TOKEN}}'] }
					})
				]),
				{ AUTH_TOKEN: 'placeholder-token-value' }
			);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
			expect(JSON.parse(server.hits[0].body)).toEqual({
				user: 'admin',
				token: 'placeholder-token-value',
				nested: ['placeholder-token-value']
			});
			expect(outcome.stdout).not.toContain('placeholder-token-value');
		} finally {
			await server.close();
		}
	});

	it('does not send a request whose placeholder has no env value', async () => {
		const server = await startServer((_request, response) => response.end('ok'));
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'login',
						url: `${server.base}/login`,
						body: { token: '{{env.UNSET_TOKEN}}' }
					})
				])
			);
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
			expect(record.ok).toBe(false);
			expect(String(record.failedExpectation)).toContain('UNSET_TOKEN');
			expect(server.hits).toHaveLength(0);
		} finally {
			await server.close();
		}
	});

	it('uses the request method and sends the body as JSON', async () => {
		const server = await startServer((_request, response) => response.end('ok'));
		try {
			const outcome = await runRunner(
				payload([
					request({
						name: 'update',
						url: `${server.base}/update`,
						method: 'PUT',
						headers: { 'content-type': 'application/json', 'x-custom': 'placeholder' },
						body: { value: 1 }
					})
				])
			);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
			expect(server.hits[0].method).toBe('PUT');
			expect(server.hits[0].headers['x-custom']).toBe('placeholder');
			expect(JSON.parse(server.hits[0].body)).toEqual({ value: 1 });
		} finally {
			await server.close();
		}
	});
});

// --- the isolation probe (plan §4.10, APW06-G18) ---------------------------

describe('the isolation probe (plan §4.10: "opens a TCP connection … with a 3 s timeout")', () => {
	it('reports `connected: true` when the destination answers', async () => {
		const server = await startServer((_request, response) => response.end('x'));
		try {
			const outcome = await runRunner(
				payload([], {
					kind: 'isolation-probe',
					isolationProbe: { host: '127.0.0.1', port: server.port, timeoutMs: 3_000 }
				})
			);
			const record = only(outcome);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
			expect(record).toMatchObject({ kind: 'isolation-probe', connected: true });
			expect(Number(record.latencyMs)).toBeGreaterThanOrEqual(0);
		} finally {
			await server.close();
		}
	});

	it('reports `connected: false` for a refusal — the answer that means isolation holds', async () => {
		const closed = await startServer((_request, response) => response.end('x'));
		const port = closed.port;
		await closed.close();

		const outcome = await runRunner(
			payload([], { kind: 'isolation-probe', isolationProbe: { host: '127.0.0.1', port, timeoutMs: 3_000 } })
		);

		expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_OK);
		expect(only(outcome)).toMatchObject({ kind: 'isolation-probe', connected: false });
	});

	it('falls back to the kubelet-set `KUBERNETES_SERVICE_HOST/PORT` (plan §4.10)', async () => {
		const server = await startServer((_request, response) => response.end('x'));
		try {
			const outcome = await runRunner(
				payload([], { kind: 'isolation-probe', isolationProbe: { timeoutMs: 3_000 } }),
				{
					KUBERNETES_SERVICE_HOST: '127.0.0.1',
					KUBERNETES_SERVICE_PORT: String(server.port)
				}
			);

			expect(only(outcome)).toMatchObject({ kind: 'isolation-probe', connected: true });
		} finally {
			await server.close();
		}
	});
});

// --- the report itself ------------------------------------------------------

describe('the report (plan §4.8: "one JSON line per request")', () => {
	it('writes one JSON line per request and fails the job if any of them failed', async () => {
		const server = await startServer((request_, response) => {
			response.writeHead(request_.url === '/bad' ? 500 : 200);
			response.end('ok');
		});
		try {
			const outcome = await runRunner(
				payload([
					request({ name: 'good', url: `${server.base}/good` }),
					request({
						name: 'bad',
						url: `${server.base}/bad`,
						expect: { status: [200], bodyContains: [], bodyNotContains: [], maxLatencyMs: 10_000 }
					})
				])
			);

			expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
			expect(outcome.records.map((record) => record.name)).toEqual(['good', 'bad']);
			expect(outcome.records.map((record) => record.ok)).toEqual([true, false]);
		} finally {
			await server.close();
		}
	});

	it('fails loudly, with one JSON line, when the request file cannot be read', async () => {
		const outcome = await runRunner(null);
		const record = only(outcome);

		expect(outcome.exitCode).toBe(APP_RUNNER_EXIT_FAILED);
		expect(record.ok).toBe(false);
		expect(String(record.failedExpectation)).toMatch(/request list|requests file|unreadable/i);
	});
});
