import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMock = vi.fn();
const ctorMock = vi.fn();

vi.mock('@slack/webhook', () => ({
	IncomingWebhook: class {
		constructor(url: string) {
			ctorMock(url);
		}
		send = sendMock;
	}
}));

import { SlackChannelPlugin } from './slack-channel-plugin.js';

describe('SlackChannelPlugin', () => {
	let plugin: SlackChannelPlugin;

	beforeEach(() => {
		plugin = new SlackChannelPlugin();
		sendMock.mockReset();
		ctorMock.mockReset();
	});

	it('declares notification-channel + notification-channel-slack', () => {
		expect(plugin.capabilities).toContain('notification-channel');
		expect(plugin.capabilities).toContain('notification-channel-slack');
		expect(plugin.shape).toBe('broadcast');
	});

	describe('verifyTarget', () => {
		it('accepts a well-formed Slack webhook URL', async () => {
			const res = await plugin.verifyTarget({ webhookUrl: 'https://hooks.slack.com/services/T/B/x' }, {});
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
		it('sends text + blocks via the @slack/webhook SDK and returns a synthetic id', async () => {
			sendMock.mockResolvedValueOnce({ text: 'ok' });
			const res = await plugin.send(
				{
					text: 'build is green',
					rich: { kind: 'slack-blocks', payload: [{ type: 'section' }] },
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' }
				},
				{}
			);
			expect(res.providerMessageId).toBe('slack-ref-1');
			expect(ctorMock).toHaveBeenCalledWith('https://hooks.slack.com/services/T/B/x');
			const message = sendMock.mock.calls[0][0];
			expect(message.text).toBe('build is green');
			expect(message.blocks).toEqual([{ type: 'section' }]);
		});

		it('throws on a Slack SDK send error (surfacing the HTTP status)', async () => {
			sendMock.mockRejectedValueOnce({
				message: 'invalid_payload',
				original: { response: { status: 400 } }
			});
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'ref-err',
						attribution: { userId: 'u1' },
						target: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' }
					},
					{}
				)
			).rejects.toThrow(/Slack webhook failed \(400\): invalid_payload/);
		});

		it('hits the idempotency cache on repeated messageRef', async () => {
			sendMock.mockResolvedValue({ text: 'ok' });
			const input = {
				text: 'x',
				messageRef: 'ref-cache',
				attribution: { userId: 'u1' },
				target: { webhookUrl: 'https://hooks.slack.com/services/T/B/x' }
			};
			await plugin.send(input, {});
			await plugin.send(input, {});
			expect(sendMock).toHaveBeenCalledTimes(1);
		});
	});
});
