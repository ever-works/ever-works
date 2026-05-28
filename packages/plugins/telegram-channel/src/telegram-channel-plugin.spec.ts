import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TelegramChannelPlugin } from './telegram-channel-plugin.js';

describe('TelegramChannelPlugin', () => {
	let plugin: TelegramChannelPlugin;

	beforeEach(() => {
		plugin = new TelegramChannelPlugin();
	});

	it('declares notification-channel + notification-channel-telegram (direct shape)', () => {
		expect(plugin.capabilities).toContain('notification-channel');
		expect(plugin.capabilities).toContain('notification-channel-telegram');
		expect(plugin.shape).toBe('direct');
	});

	describe('verifyTarget', () => {
		it('returns valid when getMe succeeds', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: { id: 42, username: ' everworks_bot' } }),
			} as Response);
			const res = await plugin.verifyTarget({ botToken: 'tok', chatId: '123' }, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ botId: 42, username: ' everworks_bot' });
		});

		it('returns invalid when getMe rejects the token', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 401,
				json: async () => ({ ok: false, description: 'Unauthorized' }),
			} as Response);
			const res = await plugin.verifyTarget({ botToken: 'bad', chatId: '123' }, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/Unauthorized/);
		});

		it('requires botToken + chatId', async () => {
			expect((await plugin.verifyTarget({ chatId: '123' }, {})).valid).toBe(false);
			expect((await plugin.verifyTarget({ botToken: 'tok' }, {})).valid).toBe(false);
		});
	});

	describe('send', () => {
		it('POSTs sendMessage + returns the telegram message id', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: { message_id: 555 } }),
			} as Response);
			const res = await plugin.send(
				{
					text: 'deploy done',
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: { botToken: 'tok', chatId: '123' },
				},
				{},
			);
			expect(res.providerMessageId).toBe('555');
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toContain('/bottok/sendMessage');
			const body = JSON.parse((init as RequestInit).body as string);
			expect(body.chat_id).toBe('123');
			expect(body.text).toBe('deploy done');
			fetchMock.mockRestore();
		});

		it('forwards MarkdownV2 for the telegram-markdown rich kind', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: { message_id: 1 } }),
			} as Response);
			await plugin.send(
				{
					text: 'fallback',
					rich: { kind: 'telegram-markdown', payload: '*bold*' },
					messageRef: 'ref-md',
					attribution: { userId: 'u1' },
					target: { botToken: 'tok', chatId: '123' },
				},
				{},
			);
			const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
			expect(body.parse_mode).toBe('MarkdownV2');
			expect(body.text).toBe('*bold*');
			fetchMock.mockRestore();
		});

		it('throws when Telegram returns ok:false', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 400,
				json: async () => ({ ok: false, error_code: 400, description: 'chat not found' }),
			} as Response);
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'ref-err',
						attribution: { userId: 'u1' },
						target: { botToken: 'tok', chatId: 'bad' },
					},
					{},
				),
			).rejects.toThrow(/Telegram sendMessage failed/);
		});

		it('hits the idempotency cache on repeated messageRef', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ ok: true, result: { message_id: 9 } }),
			} as Response);
			const input = {
				text: 'x',
				messageRef: 'ref-cache',
				attribution: { userId: 'u1' },
				target: { botToken: 'tok', chatId: '123' },
			};
			await plugin.send(input, {});
			await plugin.send(input, {});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			fetchMock.mockRestore();
		});
	});
});
