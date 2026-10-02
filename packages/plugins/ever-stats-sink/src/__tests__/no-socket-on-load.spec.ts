// Default imports: the CommonJS module objects are the ones every caller uses,
// and unlike an ESM namespace they can be spied on.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@ever-works/plugin';
import { EverStatsSinkPlugin } from '../ever-stats-sink.plugin.js';

/**
 * Loading the plugin opens no connection, resolves no name and starts no timer:
 * with statistics switched off nothing ever calls `send`, so a loaded plugin is
 * silent. The spies below are proven to see a connection by the control case.
 */
describe('EverStatsSinkPlugin.onLoad', () => {
	const spies: Array<{ mockRestore(): void }> = [];
	let calls: string[];

	beforeEach(() => {
		calls = [];
		const record = (name: string) => () => {
			calls.push(name);
			throw new Error(`${name} must not be called`);
		};
		spies.push(vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(record('net.Socket.connect') as never));
		spies.push(vi.spyOn(tls, 'connect').mockImplementation(record('tls.connect') as never));
		spies.push(vi.spyOn(http, 'request').mockImplementation(record('http.request') as never));
		spies.push(vi.spyOn(https, 'request').mockImplementation(record('https.request') as never));
		spies.push(vi.spyOn(dns, 'lookup').mockImplementation(record('dns.lookup') as never));
		spies.push(vi.spyOn(globalThis, 'fetch').mockImplementation(record('fetch') as never));
		spies.push(vi.spyOn(globalThis, 'setInterval'));
		spies.push(vi.spyOn(globalThis, 'setTimeout'));
	});

	afterEach(() => {
		while (spies.length) spies.pop()?.mockRestore();
	});

	it('opens no socket, resolves no name and starts no timer', async () => {
		const plugin = new EverStatsSinkPlugin();
		await plugin.onLoad({} as PluginContext);
		await plugin.healthCheck();
		await plugin.onUnload();

		expect(calls).toEqual([]);
		expect(vi.mocked(globalThis.setInterval)).not.toHaveBeenCalled();
		expect(vi.mocked(globalThis.setTimeout)).not.toHaveBeenCalled();
	});

	it('control: the spies do see a send', async () => {
		const plugin = new EverStatsSinkPlugin();
		await plugin.onLoad({} as PluginContext);
		const result = await plugin.send(
			{
				body: new TextEncoder().encode('{}'),
				headers: {},
				reportId: '63d8c277-7fa0-4f5d-a5a7-c88fc94e6186',
				period: '2026-10',
				final: false
			},
			{ baseUrl: 'https://stats.example.com', timeoutMs: 1_000, userAgent: 'test' }
		);
		expect(calls).toContain('fetch');
		expect(result.status).toBe('failed');
	});
});
