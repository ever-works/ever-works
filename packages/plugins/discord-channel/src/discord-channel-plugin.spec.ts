import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiscordChannelPlugin } from './discord-channel-plugin.js';

describe('DiscordChannelPlugin', () => {
	let plugin: DiscordChannelPlugin;

	beforeEach(() => {
		plugin = new DiscordChannelPlugin();
	});

	it('declares notification-channel + notification-channel-discord', () => {
		expect(plugin.capabilities).toContain('notification-channel');
		expect(plugin.capabilities).toContain('notification-channel-discord');
		expect(plugin.shape).toBe('broadcast');
	});

	describe('verifyTarget', () => {
		it('returns valid=true when Discord returns webhook metadata', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: 'wh-1', channel_id: 'ch-1', name: 'Ops' }),
			} as Response);
			const result = await plugin.verifyTarget(
				{ webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
				{},
			);
			expect(result.valid).toBe(true);
			expect(result.details).toEqual({ id: 'wh-1', channelId: 'ch-1', name: 'Ops' });
		});

		it('returns valid=false when Discord rejects the webhook', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 404,
				json: async () => ({}),
			} as Response);
			const result = await plugin.verifyTarget(
				{ webhookUrl: 'https://discord.com/api/webhooks/x/y' },
				{},
			);
			expect(result.valid).toBe(false);
			expect(result.message).toMatch(/404/);
		});

		it('returns valid=false with helpful message when webhookUrl is missing', async () => {
			const result = await plugin.verifyTarget({}, {});
			expect(result.valid).toBe(false);
			expect(result.message).toMatch(/webhookUrl/);
		});
	});

	describe('send', () => {
		it('POSTs to the webhook URL with text + embeds + returns provider id', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ id: 'msg-123' }),
			} as Response);
			const result = await plugin.send(
				{
					text: 'hello world',
					rich: { kind: 'discord-embeds', payload: [{ title: 'Test' }] },
					messageRef: 'ref-1',
					attribution: { userId: 'user-1' },
					target: { webhookUrl: 'https://discord.com/api/webhooks/1/abc' },
				},
				{},
			);
			expect(result.providerMessageId).toBe('msg-123');
			const [url, init] = fetchMock.mock.calls[0];
			expect(url).toMatch(/wait=true$/);
			const body = JSON.parse((init as RequestInit).body as string);
			expect(body.content).toBe('hello world');
			expect(body.embeds).toEqual([{ title: 'Test' }]);
		});

		it('throws on non-2xx Discord response', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 400,
				text: async () => 'Bad webhook',
				json: async () => ({}),
			} as Response);
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'ref-err',
						attribution: { userId: 'u' },
						target: { webhookUrl: 'https://discord.com/api/webhooks/x/y' },
					},
					{},
				),
			).rejects.toThrow(/Discord webhook failed/);
		});

		it('hits the idempotency cache on repeated messageRef', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({ id: 'msg-cache' }),
			} as Response);
			const input = {
				text: 'x',
				messageRef: 'ref-cache',
				attribution: { userId: 'u' },
				target: { webhookUrl: 'https://discord.com/api/webhooks/x/y' },
			};
			await plugin.send(input, {});
			await plugin.send(input, {});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});
});
