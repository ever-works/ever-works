import * as http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FLEET_SESSION_HOOK_BODY_MAX_BYTES } from '@ever-works/contracts';
import { HOOK_SESSION_HEADER, HOOK_TOKEN_HEADER, HookEndpoint, type HookEndpointEvent } from '../hook-endpoint';

/**
 * The loopback hook endpoint (FL-05 spec FR-1 … FR-6, U3, U4; ACC-FL05-01).
 */

const TOKEN = 'a'.repeat(64);
const SESSION = 'f3c1a0de-1111-4222-8333-444455556666';

function post(
	port: number,
	options: { token?: string; session?: string; path?: string; body?: string | Buffer }
): Promise<number> {
	return new Promise((resolve, reject) => {
		const body = options.body ?? '{}';
		const request = http.request(
			{
				host: '127.0.0.1',
				port,
				method: 'POST',
				path: options.path ?? '/hook/claude',
				headers: {
					'content-type': 'application/json',
					'content-length': Buffer.byteLength(body),
					...(options.token !== undefined ? { [HOOK_TOKEN_HEADER]: options.token } : {}),
					...(options.session !== undefined ? { [HOOK_SESSION_HEADER]: options.session } : {})
				}
			},
			(response) => {
				response.resume();
				response.on('end', () => resolve(response.statusCode ?? 0));
			}
		);
		request.on('error', (error: NodeJS.ErrnoException) => {
			// A refused request may be closed before the whole body went out.
			if (error.code === 'ECONNRESET' || error.code === 'EPIPE') resolve(403);
			else reject(error);
		});
		request.end(body);
	});
}

describe('HookEndpoint', () => {
	const endpoints: HookEndpoint[] = [];
	afterEach(async () => {
		for (const endpoint of endpoints.splice(0)) await endpoint.stop();
	});

	function endpoint(known: string[] = [SESSION]) {
		const events: HookEndpointEvent[] = [];
		const instance = new HookEndpoint({
			token: TOKEN,
			isKnownSession: (id) => known.includes(id),
			onEvent: (event) => events.push(event)
		});
		endpoints.push(instance);
		return { instance, events };
	}

	it('binds 127.0.0.1 on an ephemeral port and answers 204 to an authenticated event', async () => {
		const { instance, events } = endpoint();
		const { port, token } = await instance.start();
		expect(port).toBeGreaterThan(0);
		expect(token).toBe(TOKEN);
		const status = await post(port, {
			token: TOKEN,
			session: SESSION,
			body: JSON.stringify({ hook_event_name: 'Stop' })
		});
		expect(status).toBe(204);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ sessionId: SESSION, provider: 'claude', body: { hook_event_name: 'Stop' } });
	});

	it('refuses a bad token before reading the body and counts it (U4)', async () => {
		const { instance, events } = endpoint();
		const { port } = await instance.start();
		const status = await post(port, { token: 'b'.repeat(64), session: SESSION });
		expect(status).toBe(403);
		expect(events).toHaveLength(0);
		expect(instance.snapshotCounters().badToken).toBe(1);
		expect(instance.badTokenLastMinute()).toBe(1);
	});

	it('drops and counts an event for a session it does not hold (U3)', async () => {
		const { instance, events } = endpoint([]);
		const { port } = await instance.start();
		expect(await post(port, { token: TOKEN, session: SESSION })).toBe(204);
		expect(events).toHaveLength(0);
		expect(instance.snapshotCounters().unknownSession).toBe(1);
	});

	it('caps the body: an oversize event answers 204 and counts as malformed', async () => {
		const { instance, events } = endpoint();
		const { port } = await instance.start();
		const body = `{"x":"${'y'.repeat(FLEET_SESSION_HOOK_BODY_MAX_BYTES + 10)}"}`;
		expect(await post(port, { token: TOKEN, session: SESSION, body })).toBe(204);
		expect(events).toHaveLength(0);
		expect(instance.snapshotCounters().malformed).toBe(1);
	});

	it('answers only its two paths', async () => {
		const { instance } = endpoint();
		const { port } = await instance.start();
		expect(await post(port, { token: TOKEN, session: SESSION, path: '/hook/other' })).toBe(404);
	});

	it('applies a spooled event like a live one, minus the token', () => {
		const { instance, events } = endpoint();
		expect(instance.ingestSpooled(SESSION, 'codex', '{"type":"agent-turn-complete"}', 123)).toBe(true);
		expect(events[0]).toMatchObject({ provider: 'codex', at: 123, spooled: true });
		expect(instance.ingestSpooled(SESSION, 'gemini', '{}', 1)).toBe(false);
		expect(instance.ingestSpooled('../x', 'claude', '{}', 1)).toBe(false);
	});
});
