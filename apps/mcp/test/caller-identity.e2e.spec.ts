import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';

/**
 * EW — regression suite for the caller-identity seam.
 *
 * The defect this pins: every data tool returned `API Error (401)` in
 * production while the *same* token called *directly* against the API
 * returned 200. Auth on the MCP server itself was fine (`ApiKeyGuard`
 * rejected an unauthenticated request correctly and `ping` answered
 * `pong`) — the caller's identity simply never reached the upstream
 * request.
 *
 * Why an end-to-end spec and not a unit test: the existing
 * `api-client.service.spec.ts` builds `new ApiClientService(config)` by
 * hand, so it never exercises the DI/transport seam where the bug lives.
 * The units passed while the product was broken. These tests drive a
 * REAL Nest application over the REAL Streamable-HTTP transport and
 * assert on what a REAL upstream server received, so the seam is
 * covered end to end.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC_FIXTURE = join(HERE, 'fixtures', 'minimal-openapi.json');

/** One observed upstream call. */
interface UpstreamCall {
	url: string;
	authorization: string | undefined;
	apiKeyHeader: string | undefined;
}

/**
 * Stand-in for `api.ever.works`. Records the credential headers of every
 * request so a test can assert exactly what identity the MCP server
 * forwarded. `gate` lets a test hold responses open so two tool calls are
 * genuinely in flight at the same time (see the concurrency test).
 */
class UpstreamRecorder {
	readonly calls: UpstreamCall[] = [];
	maxConcurrent = 0;
	private inFlight = 0;
	private server!: Server;
	private release: (() => void) | null = null;
	private gateSize = 0;
	private gateWaiters: Array<() => void> = [];

	async start(): Promise<string> {
		this.server = createServer((req, res) => {
			this.calls.push({
				url: req.url ?? '',
				authorization: header(req.headers['authorization']),
				apiKeyHeader: header(req.headers['x-api-key'])
			});
			this.inFlight += 1;
			this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight);

			const finish = () => {
				this.inFlight -= 1;
				res.writeHead(200, { 'content-type': 'application/json' });
				// Echo the credential back so a test can correlate a response
				// with the identity that produced it.
				res.end(
					JSON.stringify({ items: [], total: 0, seenAuthorization: header(req.headers['authorization']) })
				);
			};

			if (this.gateSize > 0) {
				this.gateWaiters.push(finish);
				if (this.gateWaiters.length >= this.gateSize) {
					const waiters = this.gateWaiters;
					this.gateWaiters = [];
					this.gateSize = 0;
					for (const w of waiters) w();
					this.release?.();
				}
				return;
			}
			finish();
		});

		await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
		const { port } = this.server.address() as AddressInfo;
		return `http://127.0.0.1:${port}`;
	}

	/** Hold the next `n` upstream requests open until all `n` have arrived. */
	gateFor(n: number): void {
		this.gateSize = n;
		this.gateWaiters = [];
	}

	async stop(): Promise<void> {
		this.release = null;
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}
}

function header(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

/** Fire a JSON-RPC `tools/call` at the MCP server exactly as a client would. */
async function callTool(
	baseUrl: string,
	tool: string,
	args: Record<string, unknown>,
	jwt?: string
): Promise<{ status: number; body: string }> {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		Accept: 'application/json, text/event-stream'
	};
	if (jwt) headers['x-ever-works-jwt'] = jwt;

	const response = await fetch(`${baseUrl}/mcp`, {
		method: 'POST',
		headers,
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: tool, arguments: args }
		})
	});
	return { status: response.status, body: await response.text() };
}

const WORK_A = '11111111-1111-4111-8111-111111111111';
const WORK_B = '22222222-2222-4222-8222-222222222222';
const JWT_A = 'caller-a-token-aaaaaaaaaaaaaaaa';
const JWT_B = 'caller-b-token-bbbbbbbbbbbbbbbb';

describe('caller identity reaches the upstream API (HTTP transport)', () => {
	let app: INestApplication;
	let baseUrl: string;
	let upstream: UpstreamRecorder;
	const savedEnv = { ...process.env };

	beforeAll(async () => {
		upstream = new UpstreamRecorder();
		const upstreamUrl = await upstream.start();

		// `app.module.ts` reads MCP_TRANSPORT at module-evaluation time, so the
		// env has to be set before the dynamic import below.
		process.env.MCP_TRANSPORT = 'streamable-http';
		process.env.EVER_WORKS_MCP_AUTH_MODE = 'per-user-jwt';
		process.env.EVER_WORKS_API_URL = upstreamUrl;
		process.env.EVER_WORKS_OPENAPI_SPEC_PATH = SPEC_FIXTURE;
		// per-user-jwt mode must work with NO shared key configured. Leaving a
		// key set here would mask the privilege-escalation case the third test
		// pins, so make sure it is genuinely absent.
		delete process.env.EVER_WORKS_API_KEY;
		delete process.env.NODE_ENV;

		const { NestFactory } = await import('@nestjs/core');
		const { AppModule } = await import('../src/app.module.js');
		app = await NestFactory.create(AppModule, { logger: false });
		await app.listen(0, '127.0.0.1');
		baseUrl = await app.getUrl();
	});

	afterAll(async () => {
		await app?.close();
		await upstream?.stop();
		process.env = savedEnv;
	});

	it('forwards the caller JWT as Authorization: Bearer on the upstream request', async () => {
		const before = upstream.calls.length;
		const { status, body } = await callTool(baseUrl, 'kb.list', { workId: WORK_A }, JWT_A);

		expect(status).toBe(200);
		// The tool must not report an upstream auth failure.
		expect(body).not.toContain('API Error (401)');

		const calls = upstream.calls.slice(before);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain(`/works/${WORK_A}/kb/documents`);
		// THE ASSERTION THAT FAILS ON THE BROKEN CODE: the caller's identity
		// must be on the upstream request.
		expect(calls[0].authorization).toBe(`Bearer ${JWT_A}`);
	});

	it('keeps two concurrent callers isolated — each upstream call carries its own token', async () => {
		const before = upstream.calls.length;

		// Hold both upstream requests open until BOTH have arrived, so the two
		// tool calls genuinely overlap. A store that leaked across callers
		// (a shared mutable field, a module-level variable) shows up here.
		upstream.gateFor(2);

		const [resA, resB] = await Promise.all([
			callTool(baseUrl, 'kb.list', { workId: WORK_A }, JWT_A),
			callTool(baseUrl, 'kb.list', { workId: WORK_B }, JWT_B)
		]);

		expect(resA.status).toBe(200);
		expect(resB.status).toBe(200);
		expect(resA.body).not.toContain('API Error (401)');
		expect(resB.body).not.toContain('API Error (401)');

		const calls = upstream.calls.slice(before);
		expect(calls).toHaveLength(2);
		// Prove the requests really were simultaneous — otherwise this test
		// would pass trivially against a serialising implementation and would
		// not be testing isolation at all.
		expect(upstream.maxConcurrent).toBe(2);

		const callA = calls.find((c) => c.url.includes(WORK_A));
		const callB = calls.find((c) => c.url.includes(WORK_B));
		expect(callA, 'upstream call for caller A').toBeDefined();
		expect(callB, 'upstream call for caller B').toBeDefined();
		expect(callA!.authorization).toBe(`Bearer ${JWT_A}`);
		expect(callB!.authorization).toBe(`Bearer ${JWT_B}`);
	});

	it('rejects a request with no JWT and never falls back to a shared key', async () => {
		const before = upstream.calls.length;
		const { status, body } = await callTool(baseUrl, 'kb.list', { workId: WORK_A });

		// The guard must still refuse the request outright.
		expect(status).toBe(401);
		expect(body).toContain('Per-user JWT required');

		// And nothing may have reached the upstream API — quietly upgrading a
		// missing caller identity to a shared service key would turn an auth
		// bug into a privilege-escalation bug.
		expect(upstream.calls.slice(before)).toHaveLength(0);
	});

	it('never sends a shared API key in per-user-jwt mode', async () => {
		// Across every upstream call this suite has made, no request may have
		// carried the platform key.
		for (const call of upstream.calls) {
			expect(call.apiKeyHeader).toBeUndefined();
		}
	});
});
