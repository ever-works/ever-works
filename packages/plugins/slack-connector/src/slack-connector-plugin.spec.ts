import { describe, it, expect, beforeEach, vi } from 'vitest';

const postMessageMock = vi.fn();
const authTestMock = vi.fn();
const ctorMock = vi.fn();

vi.mock('@slack/web-api', () => ({
	WebClient: class {
		constructor(token: string) {
			ctorMock(token);
		}
		chat = { postMessage: postMessageMock };
		auth = { test: authTestMock };
	}
}));

import { SlackConnectorPlugin } from './slack-connector-plugin.js';

const TARGET = { botToken: 'xoxb-123', defaultChannelId: 'C0123456789' };

describe('SlackConnectorPlugin', () => {
	let plugin: SlackConnectorPlugin;

	beforeEach(() => {
		plugin = new SlackConnectorPlugin();
		postMessageMock.mockReset();
		authTestMock.mockReset();
		ctorMock.mockReset();
	});

	it('declares the connector + connector-slack capabilities and outbound metadata', () => {
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('connector-slack');
		expect(plugin.connector.direction).toBe('outbound');
		expect(plugin.connector.transport).toBe('webhook');
		expect(plugin.connector.flags.outboundMessage).toBe(true);
		expect(plugin.connector.flags.richOutbound).toBe(true);
		expect(plugin.connector.flags.inbound).toBe(false);
	});

	it('marks botToken + signingSecret as x-secret in the settings schema', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.botToken['x-secret']).toBe(true);
		expect(props.signingSecret['x-secret']).toBe(true);
		expect(plugin.settingsSchema.required).toContain('botToken');
	});

	describe('verifyConnection', () => {
		it('returns valid + details when auth.test succeeds', async () => {
			authTestMock.mockResolvedValueOnce({
				team_id: 'T1',
				team: 'Acme',
				user_id: 'U1',
				url: 'https://acme.slack.com'
			});
			const res = await plugin.verifyConnection(TARGET, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ teamId: 'T1', botUserId: 'U1' });
			expect(ctorMock).toHaveBeenCalledWith('xoxb-123');
		});

		it('returns invalid without calling Slack when botToken is missing', async () => {
			const res = await plugin.verifyConnection({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/botToken/);
			expect(authTestMock).not.toHaveBeenCalled();
		});

		it('returns invalid and surfaces the Slack error when auth.test fails', async () => {
			authTestMock.mockRejectedValueOnce({ data: { error: 'invalid_auth' } });
			const res = await plugin.verifyConnection(TARGET, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/invalid_auth/);
		});
	});

	describe('send', () => {
		it('posts text + blocks via chat.postMessage and returns the message ts', async () => {
			postMessageMock.mockResolvedValueOnce({ ok: true, channel: 'C0123456789', ts: '1700000000.000100' });
			const res = await plugin.send(
				{
					text: 'build is green',
					rich: { kind: 'slack-blocks', payload: [{ type: 'section' }] },
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: TARGET
				},
				{ connectorId: 'conn-1' }
			);
			expect(res.providerMessageId).toBe('1700000000.000100');
			expect(res.provider).toBe('slack-connector');
			expect(ctorMock).toHaveBeenCalledWith('xoxb-123');
			const args = postMessageMock.mock.calls[0][0];
			expect(args.channel).toBe('C0123456789');
			expect(args.text).toBe('build is green');
			expect(args.blocks).toEqual([{ type: 'section' }]);
		});

		it('throws when no channel id can be resolved', async () => {
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'ref-nochan',
						attribution: { userId: 'u1' },
						target: { botToken: 'xoxb-123' }
					},
					{}
				)
			).rejects.toThrow(/channel id is required/);
			expect(postMessageMock).not.toHaveBeenCalled();
		});

		it('throws and surfaces the Slack error on a postMessage failure', async () => {
			postMessageMock.mockRejectedValueOnce({ data: { error: 'channel_not_found' } });
			await expect(
				plugin.send(
					{ text: 'x', messageRef: 'ref-err', attribution: { userId: 'u1' }, target: TARGET },
					{ connectorId: 'conn-1' }
				)
			).rejects.toThrow(/Slack chat\.postMessage failed: channel_not_found/);
		});

		it('hits the idempotency cache on a repeated messageRef', async () => {
			postMessageMock.mockResolvedValue({ ok: true, channel: 'C0123456789', ts: '1700000000.000200' });
			const input = {
				text: 'x',
				messageRef: 'ref-cache',
				attribution: { userId: 'u1' },
				target: TARGET
			};
			await plugin.send(input, { connectorId: 'conn-1' });
			await plugin.send(input, { connectorId: 'conn-1' });
			expect(postMessageMock).toHaveBeenCalledTimes(1);
		});

		it('resolves a per-send channelId override ahead of defaultChannelId', async () => {
			postMessageMock.mockResolvedValueOnce({ ok: true, channel: 'C999', ts: '1700000000.000300' });
			await plugin.send(
				{
					text: 'hi',
					messageRef: 'ref-override',
					attribution: { userId: 'u1' },
					target: { botToken: 'xoxb-123', channelId: 'C999', defaultChannelId: 'C0123456789' }
				},
				{ connectorId: 'conn-1' }
			);
			expect(postMessageMock.mock.calls[0][0].channel).toBe('C999');
		});
	});
});
