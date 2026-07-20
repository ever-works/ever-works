import { describe, it, expect, beforeEach, vi } from 'vitest';

const postMock = vi.fn();
const getMock = vi.fn();
const setTokenMock = vi.fn();

vi.mock('discord.js', () => ({
	REST: class {
		setToken(token: string) {
			setTokenMock(token);
			return this;
		}
		get = getMock;
		post = postMock;
	}
}));

import { DiscordConnectorPlugin } from './discord-connector-plugin.js';

const TARGET = { botToken: 'bot-abc', defaultChannelId: '123456789012345678' };

describe('DiscordConnectorPlugin', () => {
	let plugin: DiscordConnectorPlugin;

	beforeEach(() => {
		plugin = new DiscordConnectorPlugin();
		postMock.mockReset();
		getMock.mockReset();
		setTokenMock.mockReset();
	});

	it('declares the connector + connector-discord capabilities and outbound metadata', () => {
		expect(plugin.category).toBe('connector');
		expect(plugin.capabilities).toContain('connector');
		expect(plugin.capabilities).toContain('connector-discord');
		expect(plugin.connector.direction).toBe('outbound');
		expect(plugin.connector.transport).toBe('webhook');
		expect(plugin.connector.flags.outboundMessage).toBe(true);
		expect(plugin.connector.flags.richOutbound).toBe(true);
		expect(plugin.connector.flags.inbound).toBe(false);
	});

	it('marks botToken + publicKey as x-secret in the settings schema', () => {
		const props = plugin.settingsSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.botToken['x-secret']).toBe(true);
		expect(props.publicKey['x-secret']).toBe(true);
		expect(plugin.settingsSchema.required).toContain('botToken');
	});

	describe('verifyConnection', () => {
		it('returns valid + details when users/@me succeeds', async () => {
			getMock.mockResolvedValueOnce({ id: 'B1', username: 'everbot', discriminator: '0' });
			const res = await plugin.verifyConnection(TARGET, {});
			expect(res.valid).toBe(true);
			expect(res.details).toMatchObject({ botUserId: 'B1', username: 'everbot' });
			expect(setTokenMock).toHaveBeenCalledWith('bot-abc');
			expect(getMock).toHaveBeenCalledWith('/users/@me');
		});

		it('returns invalid without calling Discord when botToken is missing', async () => {
			const res = await plugin.verifyConnection({}, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/botToken/);
			expect(getMock).not.toHaveBeenCalled();
		});

		it('returns invalid and surfaces the Discord error when users/@me fails', async () => {
			getMock.mockRejectedValueOnce({ message: '401: Unauthorized', code: 0 });
			const res = await plugin.verifyConnection(TARGET, {});
			expect(res.valid).toBe(false);
			expect(res.message).toMatch(/Unauthorized/);
		});
	});

	describe('send', () => {
		it('posts content + embeds via the REST client and returns the message id', async () => {
			postMock.mockResolvedValueOnce({ id: '111222333444555666' });
			const res = await plugin.send(
				{
					text: 'build is green',
					rich: { kind: 'discord-embeds', payload: [{ title: 'ok' }] },
					messageRef: 'ref-1',
					attribution: { userId: 'u1' },
					target: TARGET
				},
				{ connectorId: 'conn-1' }
			);
			expect(res.providerMessageId).toBe('111222333444555666');
			expect(res.provider).toBe('discord-connector');
			expect(setTokenMock).toHaveBeenCalledWith('bot-abc');
			const [route, opts] = postMock.mock.calls[0];
			expect(route).toBe('/channels/123456789012345678/messages');
			expect(opts.body.content).toBe('build is green');
			expect(opts.body.embeds).toEqual([{ title: 'ok' }]);
		});

		it('throws when no channel id can be resolved', async () => {
			await expect(
				plugin.send(
					{
						text: 'x',
						messageRef: 'ref-nochan',
						attribution: { userId: 'u1' },
						target: { botToken: 'bot-abc' }
					},
					{}
				)
			).rejects.toThrow(/channel id is required/);
			expect(postMock).not.toHaveBeenCalled();
		});

		it('throws and surfaces the Discord error on a post failure', async () => {
			postMock.mockRejectedValueOnce({ message: 'Missing Access', code: 50001 });
			await expect(
				plugin.send(
					{ text: 'x', messageRef: 'ref-err', attribution: { userId: 'u1' }, target: TARGET },
					{ connectorId: 'conn-1' }
				)
			).rejects.toThrow(/Discord channel message failed: Missing Access/);
		});

		it('hits the idempotency cache on a repeated messageRef', async () => {
			postMock.mockResolvedValue({ id: '999888777666555444' });
			const input = {
				text: 'x',
				messageRef: 'ref-cache',
				attribution: { userId: 'u1' },
				target: TARGET
			};
			await plugin.send(input, { connectorId: 'conn-1' });
			await plugin.send(input, { connectorId: 'conn-1' });
			expect(postMock).toHaveBeenCalledTimes(1);
		});

		it('resolves a per-send channelId override ahead of defaultChannelId', async () => {
			postMock.mockResolvedValueOnce({ id: '777' });
			await plugin.send(
				{
					text: 'hi',
					messageRef: 'ref-override',
					attribution: { userId: 'u1' },
					target: { botToken: 'bot-abc', channelId: '999', defaultChannelId: '123456789012345678' }
				},
				{ connectorId: 'conn-1' }
			);
			expect(postMock.mock.calls[0][0]).toBe('/channels/999/messages');
		});
	});
});
