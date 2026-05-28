import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMessageMock = vi.fn();
const getMeMock = vi.fn();
const ctorMock = vi.fn();

vi.mock('grammy', () => ({
	Api: class {
		constructor(token: string) {
			ctorMock(token);
		}
		sendMessage = sendMessageMock;
		getMe = getMeMock;
	}
}));

import { TelegramChannelPlugin } from './telegram-channel-plugin.js';

describe('TelegramChannelPlugin', () => {
	let plugin: TelegramChannelPlugin;

	beforeEach(() => {
		plugin = new TelegramChannelPlugin();
		sendMessageMock.mockReset();
		getMeMock.mockReset();
		ctorMock.mockReset();
	});

	it('declares notification-channel + notification-channel-telegram (direct shape)', () => {
		expect(plugin.capabilities).toContain('notification-channel');
		expect(plugin.capabilities).toContain('notification-channel-telegram');
		expect(plugin.shape).toBe('direct');
	});

	describe('verifyTarget', () => {
		it('returns valid when getMe succeeds', async () => {
			getMeMock.mockResolvedValueOnce({ id: 42, username: 'everworks_bot' });
			const res = await plugin.verifyTarget({ botToken: 'tok', chatId: '123' }, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ botId: 42, username: 'everworks_bot' });
			expect(ctorMock).toHaveBeenCalledWith('tok');
		});

		it('returns invalid when getMe rejects the token', async () => {
			getMeMock.mockRejectedValueOnce({ error_code: 401, description: 'Unauthorized' });
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
		it('sends via the grammy Api and returns the telegram message id', async () => {
			sendMessageMock.mockResolvedValueOnce({ message_id: 555 });
			const res = await plugin.send(
				{
					text: 'deploy done',
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: { botToken: 'tok', chatId: '123' }
				},
				{}
			);
			expect(res.providerMessageId).toBe('555');
			expect(ctorMock).toHaveBeenCalledWith('tok');
			const [chatId, text] = sendMessageMock.mock.calls[0];
			expect(chatId).toBe('123');
			expect(text).toBe('deploy done');
		});

		it('forwards MarkdownV2 for the telegram-markdown rich kind', async () => {
			sendMessageMock.mockResolvedValueOnce({ message_id: 1 });
			await plugin.send(
				{
					text: 'fallback',
					rich: { kind: 'telegram-markdown', payload: '*bold*' },
					messageRef: 'ref-md',
					attribution: { userId: 'u1' },
					target: { botToken: 'tok', chatId: '123' }
				},
				{}
			);
			const [, text, other] = sendMessageMock.mock.calls[0];
			expect(text).toBe('*bold*');
			expect(other.parse_mode).toBe('MarkdownV2');
		});

		it('throws when the grammy Api send rejects (surfacing error_code + description)', async () => {
			sendMessageMock.mockRejectedValueOnce({ error_code: 400, description: 'chat not found' });
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'ref-err',
						attribution: { userId: 'u1' },
						target: { botToken: 'tok', chatId: 'bad' }
					},
					{}
				)
			).rejects.toThrow(/Telegram sendMessage failed \(400\): chat not found/);
		});

		it('hits the idempotency cache on repeated messageRef', async () => {
			sendMessageMock.mockResolvedValue({ message_id: 9 });
			const input = {
				text: 'x',
				messageRef: 'ref-cache',
				attribution: { userId: 'u1' },
				target: { botToken: 'tok', chatId: '123' }
			};
			await plugin.send(input, {});
			await plugin.send(input, {});
			expect(sendMessageMock).toHaveBeenCalledTimes(1);
		});
	});
});
