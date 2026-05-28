import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WhatsappChannelPlugin } from './whatsapp-channel-plugin.js';

describe('WhatsappChannelPlugin', () => {
	let plugin: WhatsappChannelPlugin;
	const target = { accessToken: 'tok', phoneNumberId: '111', to: '+15551234567' };

	beforeEach(() => {
		plugin = new WhatsappChannelPlugin();
	});

	it('declares notification-channel + notification-channel-whatsapp (direct shape)', () => {
		expect(plugin.capabilities).toContain('notification-channel');
		expect(plugin.capabilities).toContain('notification-channel-whatsapp');
		expect(plugin.shape).toBe('direct');
	});

	describe('verifyTarget', () => {
		it('returns valid when the phone-number lookup succeeds', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: '111', display_phone_number: '+1 555 123 4567' }),
			} as Response);
			const res = await plugin.verifyTarget(target, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ phoneNumberId: '111' });
		});

		it('returns invalid on a Graph API error', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: async () => ({ error: { message: 'Invalid OAuth access token' } }),
			} as Response);
			const res = await plugin.verifyTarget(target, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/Invalid OAuth/);
		});

		it('requires accessToken + phoneNumberId + to', async () => {
			expect((await plugin.verifyTarget({ phoneNumberId: '1', to: 'x' }, {})).valid).toBe(false);
			expect((await plugin.verifyTarget({ accessToken: 't', to: 'x' }, {})).valid).toBe(false);
			expect((await plugin.verifyTarget({ accessToken: 't', phoneNumberId: '1' }, {})).valid).toBe(
				false,
			);
		});
	});

	describe('send', () => {
		it('sends an in-window text message + returns the wa message id', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ messages: [{ id: 'wamid.ABC' }] }),
			} as Response);
			const res = await plugin.send(
				{ text: 'order shipped', messageRef: 'ref-1', attribution: { userId: 'u1' }, target },
				{},
			);
			expect(res.providerMessageId).toBe('wamid.ABC');
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toContain('/111/messages');
			const body = JSON.parse((init as RequestInit).body as string);
			expect(body.type).toBe('text');
			expect(body.text.body).toBe('order shipped');
			fetchMock.mockRestore();
		});

		it('sends a template payload for the whatsapp-template rich kind', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ messages: [{ id: 'wamid.TPL' }] }),
			} as Response);
			await plugin.send(
				{
					text: 'fallback',
					rich: {
						kind: 'whatsapp-template',
						payload: { name: 'order_update', language: { code: 'en_US' } },
					},
					messageRef: 'ref-tpl',
					attribution: { userId: 'u1' },
					target,
				},
				{},
			);
			const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
			expect(body.type).toBe('template');
			expect(body.template).toMatchObject({ name: 'order_update' });
			fetchMock.mockRestore();
		});

		it('throws when the API returns an error / no message id', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 400,
				json: async () => ({ error: { message: 'recipient not in allowed list', code: 131030 } }),
			} as Response);
			await expect(
				plugin.send(
					{ text: 'x', messageRef: 'ref-err', attribution: { userId: 'u1' }, target },
					{},
				),
			).rejects.toThrow(/WhatsApp send failed/);
		});

		it('hits the idempotency cache on repeated messageRef', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ messages: [{ id: 'wamid.CACHE' }] }),
			} as Response);
			const input = { text: 'x', messageRef: 'ref-cache', attribution: { userId: 'u1' }, target };
			await plugin.send(input, {});
			await plugin.send(input, {});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			fetchMock.mockRestore();
		});
	});
});
