import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NovuChannelPlugin } from './novu-channel-plugin.js';

describe('NovuChannelPlugin', () => {
	let plugin: NovuChannelPlugin;
	const target = { apiKey: 'key', workflowId: 'wf-1', subscriberId: 'sub-1' };

	beforeEach(() => {
		plugin = new NovuChannelPlugin();
	});

	it('declares notification-channel + notification-channel-novu (workflow shape)', () => {
		expect(plugin.capabilities).toContain('notification-channel');
		expect(plugin.capabilities).toContain('notification-channel-novu');
		expect(plugin.shape).toBe('workflow');
	});

	describe('verifyTarget', () => {
		it('returns valid when the environments/me probe succeeds', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ data: { name: 'Development', _id: 'env-1' } }),
			} as Response);
			const res = await plugin.verifyTarget(target, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ environment: 'Development' });
		});

		it('returns invalid on an unauthorized key', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: async () => ({ message: 'API Key not found' }),
			} as Response);
			const res = await plugin.verifyTarget(target, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/API Key not found/);
		});

		it('requires apiKey + workflowId + subscriberId', async () => {
			expect((await plugin.verifyTarget({ workflowId: 'w', subscriberId: 's' }, {})).valid).toBe(
				false,
			);
			expect((await plugin.verifyTarget({ apiKey: 'k', subscriberId: 's' }, {})).valid).toBe(false);
			expect((await plugin.verifyTarget({ apiKey: 'k', workflowId: 'w' }, {})).valid).toBe(false);
		});
	});

	describe('send', () => {
		it('triggers the workflow + returns the transactionId', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 201,
				json: async () => ({ data: { transactionId: 'txn-1', acknowledged: true } }),
			} as Response);
			const res = await plugin.send(
				{ text: 'hello', messageRef: 'ref-1', attribution: { userId: 'u1' }, target },
				{},
			);
			expect(res.providerMessageId).toBe('txn-1');
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toContain('/v1/events/trigger');
			const body = JSON.parse((init as RequestInit).body as string);
			expect(body.name).toBe('wf-1');
			expect(body.to).toEqual({ subscriberId: 'sub-1' });
			expect(body.payload.text).toBe('hello');
			fetchMock.mockRestore();
		});

		it('merges novu-payload rich content into the trigger payload', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 201,
				json: async () => ({ data: { transactionId: 'txn-2' } }),
			} as Response);
			await plugin.send(
				{
					text: 'base',
					rich: { kind: 'novu-payload', payload: { ctaUrl: 'https://x', count: 3 } },
					messageRef: 'ref-rich',
					attribution: { userId: 'u1' },
					target,
				},
				{},
			);
			const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
			expect(body.payload).toMatchObject({ text: 'base', ctaUrl: 'https://x', count: 3 });
			fetchMock.mockRestore();
		});

		it('honours a self-hosted apiBase setting', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 201,
				json: async () => ({ data: { transactionId: 'txn-3' } }),
			} as Response);
			await plugin.send(
				{ text: 'x', messageRef: 'ref-eu', attribution: { userId: 'u1' }, target },
				{ settings: { apiBase: 'https://eu.api.novu.co/' } },
			);
			expect(fetchMock.mock.calls[0][0]).toBe('https://eu.api.novu.co/v1/events/trigger');
			fetchMock.mockRestore();
		});

		it('throws when no transactionId is returned', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 400,
				json: async () => ({ message: 'workflow not found' }),
			} as Response);
			await expect(
				plugin.send(
					{ text: 'x', messageRef: 'ref-err', attribution: { userId: 'u1' }, target },
					{},
				),
			).rejects.toThrow(/Novu trigger failed/);
		});

		it('hits the idempotency cache on repeated messageRef', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: true,
				status: 201,
				json: async () => ({ data: { transactionId: 'txn-cache' } }),
			} as Response);
			const input = { text: 'x', messageRef: 'ref-cache', attribution: { userId: 'u1' }, target };
			await plugin.send(input, {});
			await plugin.send(input, {});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			fetchMock.mockRestore();
		});
	});
});
