import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackChannelPlugin } from './slack-channel-plugin.js';

describe('SlackChannelPlugin', () => {
	let plugin: SlackChannelPlugin;

	beforeEach(() => {
		plugin = new SlackChannelPlugin();
	});

	it('declares notification-channel + notification-channel-slack', () => {
		expect(plugin.capabilities).toContain('notification-channel');
		expect(plugin.capabilities).toContain('notification-channel-slack');
		expect(plugin.shape).toBe('broadcast');
	});

	describe('verifyTarget', () => {
		it('accepts a well-formed Slack webhook URL', async () => {
			const res = await plugin.verifyTarget(
				{ webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
				{},
			);
			expect(res.valid).toBe(true);
		});

		it('rejects a non-Slack URL', async () => {
			const res = await plugin.verifyTarget({ webhookUrl: 'https://example.com/hook' }, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/hooks\.slack\.com/);
		});

		it('rejects a missing webhookUrl', async () => {
			const res = await plugin.verifyTarget({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/webhookUrl/);
		});
	});

	describe('send', () => {
		it('POSTs text + blocks to the webhook and returns a synthetic id', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: true,
				status: 200,
				text: async () => 'ok',
			} as Response);
			const res = await plugin.send(
				{
					text: 'build is green',
					rich: { kind: 'slack-blocks', payload: [{ type: 'section' }] },
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
				},
				{},
			);
			expect(res.providerMessageId).toBe('slack-ref-1');
			const [, init] = fetchMock.mock.calls[0];
			const body = JSON.parse((init as RequestInit).body as string);
			expect(body.text).toBe('build is green');
			expect(body.blocks).toEqual([{ type: 'section' }]);
			fetchMock.mockRestore();
		});

		it('throws on non-2xx Slack response', async () => {
			vi.spyOn(global, 'fetch').mockResolvedValueOnce({
				ok: false,
				status: 400,
				text: async () => 'invalid_payload',
			} as Response);
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'ref-err',
						attribution: { userId: 'u1' },
						target: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
					},
					{},
				),
			).rejects.toThrow(/Slack webhook failed/);
		});

		it('hits the idempotency cache on repeated messageRef', async () => {
			const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => 'ok',
			} as Response);
			const input = {
				text: 'x',
				messageRef: 'ref-cache',
				attribution: { userId: 'u1' },
				target: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' },
			};
			await plugin.send(input, {});
			await plugin.send(input, {});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			fetchMock.mockRestore();
		});
	});
});
