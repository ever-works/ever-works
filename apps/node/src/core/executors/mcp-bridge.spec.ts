import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, REDACTED, type LogEntry } from '../logger';
import {
	assertUpstreamUrl,
	isLoopbackPeer,
	McpBridgeError,
	MCP_BRIDGE_MAX_REQUEST_BYTES,
	startMcpLoopbackProxy,
	type McpBridgeFetch,
	type McpLoopbackProxy
} from './mcp-bridge';

/**
 * Self-build slice Z (EW-796) — the node's loopback MCP proxy.
 *
 * These specs drive a REAL listener on 127.0.0.1 with a stubbed upstream,
 * because the properties that matter here are properties of an actual
 * socket: which peers reach it, which paths it answers, and what leaves
 * the machine. A mocked server would prove none of them.
 *
 * The load-bearing assertions:
 *   - the credential is added to the OUTBOUND request and appears
 *     nowhere else — not in the config the model reads, not in a log;
 *   - a non-loopback peer is refused;
 *   - a path without the run's nonce is refused, so another local user
 *     port-scanning 127.0.0.1 finds nothing usable;
 *   - `close()` really stops it, so a finalized run leaves no live
 *     credential path behind.
 */

const openProxies: McpLoopbackProxy[] = [];

afterEach(async () => {
	while (openProxies.length > 0) {
		await openProxies.pop()?.close();
	}
});

function track(proxy: McpLoopbackProxy): McpLoopbackProxy {
	openProxies.push(proxy);
	return proxy;
}

/** Records every upstream call and answers a fixed JSON body. */
function recordingFetch(): {
	fetchFn: McpBridgeFetch;
	calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
} {
	const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
	const fetchFn: McpBridgeFetch = async (url, init) => {
		calls.push({
			url,
			method: init.method,
			headers: { ...init.headers },
			...(init.body !== undefined ? { body: Buffer.from(init.body as Uint8Array).toString('utf8') } : {})
		});
		return {
			status: 200,
			headers: { get: (name: string) => (name === 'content-type' ? 'application/json' : null) },
			text: async () => '{"jsonrpc":"2.0","id":1,"result":{}}'
		};
	};
	return { fetchFn, calls };
}

const TOOL_CALL_BODY = JSON.stringify({
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name: 'list_tasks' }
});

async function post(url: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body
	});
}

describe('startMcpLoopbackProxy — the credential path', () => {
	it('injects the run token as x-ever-works-jwt on the way out', async () => {
		const { fetchFn, calls } = recordingFetch();
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn
			})
		);

		const response = await post(proxy.url, TOOL_CALL_BODY);
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.headers['x-ever-works-jwt']).toBe('ew_run_deadbeefdeadbeef');
		expect(calls[0]?.url).toBe('https://mcp.example.com/mcp');
	});

	it('never sends the token as Authorization (that slot is the MCP shared key)', async () => {
		const { fetchFn, calls } = recordingFetch();
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn
			})
		);
		await post(proxy.url, TOOL_CALL_BODY);
		const sent = calls[0]?.headers ?? {};
		expect(sent['authorization']).toBeUndefined();
		expect(sent['Authorization']).toBeUndefined();
	});

	it('picks up a ROTATED token on the next request without restarting', async () => {
		const { fetchFn, calls } = recordingFetch();
		let current = 'ew_run_first000000000000';
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => current,
				fetchFn
			})
		);
		await post(proxy.url, TOOL_CALL_BODY);
		current = 'ew_run_second00000000000';
		await post(proxy.url, TOOL_CALL_BODY);

		expect(calls.map((call) => call.headers['x-ever-works-jwt'])).toEqual([
			'ew_run_first000000000000',
			'ew_run_second00000000000'
		]);
	});

	it('refuses locally, forwarding nothing, when no credential is in memory', async () => {
		const { fetchFn, calls } = recordingFetch();
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => null,
				fetchFn
			})
		);
		const response = await post(proxy.url, TOOL_CALL_BODY);
		expect(response.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it('does not leak the token into node logs', async () => {
		const entries: LogEntry[] = [];
		const logger = createLogger({ sink: (entry) => entries.push(entry) });
		const token = 'ew_run_supersecrettokenvalue';
		logger.protect(token);

		const failing: McpBridgeFetch = async () => {
			throw new Error(`upstream rejected token ${token}`);
		};
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => token,
				fetchFn: failing,
				logger
			})
		);
		const response = await post(proxy.url, TOOL_CALL_BODY);
		expect(response.status).toBe(502);

		const text = entries.map((entry) => entry.message).join('\n');
		expect(text).not.toContain(token);
		expect(text).toContain(REDACTED);
	});
});

describe('startMcpLoopbackProxy — what it refuses', () => {
	it('answers 404 on any path that is not the run nonce', async () => {
		const { fetchFn, calls } = recordingFetch();
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn,
				nonce: 'aaaabbbbccccdddd'
			})
		);
		const base = proxy.url.replace('/mcp/aaaabbbbccccdddd', '');

		for (const path of ['/', '/mcp', '/mcp/', '/mcp/wrongnonce0000', '/other']) {
			const response = await post(`${base}${path}`, TOOL_CALL_BODY);
			expect(response.status, path).toBe(404);
		}
		expect(calls).toHaveLength(0);
	});

	it('generates a fresh nonce per run, so one run cannot reach another', async () => {
		const { fetchFn } = recordingFetch();
		const first = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn
			})
		);
		const second = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn
			})
		);
		const nonceOf = (url: string) => url.split('/mcp/')[1];
		expect(nonceOf(first.url)).not.toBe(nonceOf(second.url));
		expect(nonceOf(first.url)).toMatch(/^[a-f0-9]{32}$/);
	});

	it('binds 127.0.0.1 only — nothing off this machine can reach it', async () => {
		const { fetchFn } = recordingFetch();
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn
			})
		);
		expect(proxy.address).toBe('127.0.0.1');
		expect(proxy.url.startsWith('http://127.0.0.1:')).toBe(true);
	});

	it('the per-request peer check admits only genuine loopback addresses', () => {
		// The bind above is the first defence; this predicate is the second,
		// applied per CONNECTION. It is exact-match rather than prefix-match
		// on purpose — `::ffff:10.0.0.9` is an off-box address in IPv4-mapped
		// clothing and a `startsWith('::ffff:')` test would wave it through.
		expect(isLoopbackPeer('127.0.0.1')).toBe(true);
		expect(isLoopbackPeer('::1')).toBe(true);
		expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);

		expect(isLoopbackPeer('10.0.0.9')).toBe(false);
		expect(isLoopbackPeer('192.168.1.5')).toBe(false);
		expect(isLoopbackPeer('::ffff:10.0.0.9')).toBe(false);
		expect(isLoopbackPeer('127.0.0.1:1234')).toBe(false);
		expect(isLoopbackPeer('')).toBe(false);
		expect(isLoopbackPeer(undefined)).toBe(false);
		expect(isLoopbackPeer(null)).toBe(false);
	});

	it('refuses methods outside the streamable-HTTP set', async () => {
		const { fetchFn, calls } = recordingFetch();
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn
			})
		);
		const response = await fetch(proxy.url, { method: 'PUT' });
		expect(response.status).toBe(405);
		expect(calls).toHaveLength(0);
	});

	it('forwards only the allowlisted request headers', async () => {
		const { fetchFn, calls } = recordingFetch();
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn
			})
		);
		await post(proxy.url, TOOL_CALL_BODY, {
			cookie: 'session=abc',
			authorization: 'Bearer someone-elses-key',
			'x-forwarded-for': '10.0.0.1',
			'mcp-session-id': 'sess-1'
		});

		const sent = calls[0]?.headers ?? {};
		expect(sent['mcp-session-id']).toBe('sess-1');
		expect(sent['content-type']).toBe('application/json');
		expect(sent['cookie']).toBeUndefined();
		expect(sent['authorization']).toBeUndefined();
		expect(sent['x-forwarded-for']).toBeUndefined();
	});

	it('refuses a body over the cap without forwarding it', async () => {
		const { fetchFn, calls } = recordingFetch();
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn
			})
		);
		const huge = 'x'.repeat(MCP_BRIDGE_MAX_REQUEST_BYTES + 1024);
		await post(proxy.url, huge).catch(() => undefined);
		expect(calls).toHaveLength(0);
	});
});

describe('startMcpLoopbackProxy — lifecycle and counting', () => {
	it('counts tools/call requests and ignores the rest', async () => {
		const { fetchFn } = recordingFetch();
		const proxy = track(
			await startMcpLoopbackProxy({
				upstreamUrl: 'https://mcp.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef',
				fetchFn
			})
		);
		expect(proxy.toolCalls()).toBe(0);

		await post(proxy.url, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
		expect(proxy.toolCalls()).toBe(0);

		await post(proxy.url, TOOL_CALL_BODY);
		await post(proxy.url, TOOL_CALL_BODY);
		expect(proxy.toolCalls()).toBe(2);

		// A body it cannot parse is still forwarded, and simply not counted.
		await post(proxy.url, 'not json at all');
		expect(proxy.toolCalls()).toBe(2);
	});

	it('stops answering after close(), and close() is idempotent', async () => {
		const { fetchFn } = recordingFetch();
		const proxy = await startMcpLoopbackProxy({
			upstreamUrl: 'https://mcp.example.com/mcp',
			token: () => 'ew_run_deadbeefdeadbeef',
			fetchFn
		});
		expect((await post(proxy.url, TOOL_CALL_BODY)).status).toBe(200);

		await proxy.close();
		await proxy.close();

		await expect(post(proxy.url, TOOL_CALL_BODY)).rejects.toThrow();
	});
});

describe('assertUpstreamUrl', () => {
	it('accepts https anywhere', () => {
		expect(assertUpstreamUrl('https://mcp.example.com/mcp')).toContain('https://mcp.example.com/mcp');
	});

	it('accepts plain http only on loopback (local development)', () => {
		expect(assertUpstreamUrl('http://localhost:3200/mcp')).toContain('http://localhost:3200/mcp');
		expect(assertUpstreamUrl('http://127.0.0.1:3200/mcp')).toContain('http://127.0.0.1:3200/mcp');
	});

	it('refuses plain http to a remote host — a credential must not ride cleartext', () => {
		expect(() => assertUpstreamUrl('http://mcp.example.com/mcp')).toThrow(McpBridgeError);
	});

	it('refuses anything that is not an absolute http(s) URL', () => {
		expect(() => assertUpstreamUrl('')).toThrow(McpBridgeError);
		expect(() => assertUpstreamUrl('/mcp')).toThrow(McpBridgeError);
		expect(() => assertUpstreamUrl('file:///etc/passwd')).toThrow(McpBridgeError);
		expect(() => assertUpstreamUrl('ftp://example.com/mcp')).toThrow(McpBridgeError);
	});

	it('is enforced by startMcpLoopbackProxy itself', async () => {
		await expect(
			startMcpLoopbackProxy({
				upstreamUrl: 'http://evil.example.com/mcp',
				token: () => 'ew_run_deadbeefdeadbeef'
			})
		).rejects.toThrow(McpBridgeError);
	});
});
