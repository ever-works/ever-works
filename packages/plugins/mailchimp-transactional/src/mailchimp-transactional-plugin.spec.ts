import { describe, it, expect, beforeEach, vi } from 'vitest';

// `vi.hoisted` so the mock fns are initialized before vitest's hoisted
// `vi.mock` factory + the (also hoisted) impl import reference them.
const { sendMock, factoryMock } = vi.hoisted(() => {
	const sendMock = vi.fn();
	return { sendMock, factoryMock: vi.fn(() => ({ messages: { send: sendMock } })) };
});

vi.mock('@mailchimp/mailchimp_transactional', () => ({
	default: factoryMock
}));

import { MailchimpTransactionalPlugin } from './mailchimp-transactional-plugin.js';

describe('MailchimpTransactionalPlugin', () => {
	let plugin: MailchimpTransactionalPlugin;

	beforeEach(() => {
		plugin = new MailchimpTransactionalPlugin();
		process.env.MANDRILL_API_KEY = 'test-key';
		sendMock.mockReset();
		factoryMock.mockClear();
	});

	it('declares the email-outbound capability', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.id).toBe('mailchimp-transactional');
	});

	it('sends via the SDK (messages.send) and reads the first _id', async () => {
		sendMock.mockResolvedValueOnce([{ email: 'b@example.com', status: 'sent', _id: 'mand-1' }]);

		const result = await plugin.sendEmail(
			{
				from: 'a@example.com',
				to: ['b@example.com'],
				cc: ['c@example.com'],
				subject: 'hi',
				bodyText: 'hi',
				messageRef: 'ref-1'
			},
			{ userId: 'u' }
		);

		expect(result.providerMessageId).toBe('mand-1');
		expect(result.accepted).toContain('b@example.com');
		expect(factoryMock).toHaveBeenCalledWith('test-key');
		const body = sendMock.mock.calls[0][0];
		expect(body.message.to).toEqual([
			{ email: 'b@example.com', type: 'to' },
			{ email: 'c@example.com', type: 'cc' }
		]);
	});

	it('surfaces per-recipient rejections in the result', async () => {
		sendMock.mockResolvedValueOnce([
			{ email: 'ok@example.com', status: 'queued', _id: 'mand-2' },
			{ email: 'bad@example.com', status: 'rejected', reject_reason: 'hard-bounce' }
		]);

		const result = await plugin.sendEmail(
			{
				from: 'a@x.com',
				to: ['ok@example.com', 'bad@example.com'],
				subject: 's',
				bodyText: 't',
				messageRef: 'r2'
			},
			{ userId: 'u' }
		);
		expect(result.accepted).toEqual(['ok@example.com']);
		expect(result.rejected).toEqual([{ address: 'bad@example.com', reason: 'hard-bounce' }]);
	});

	it('throws on a Mandrill error envelope (SDK resolves, does not reject)', async () => {
		sendMock.mockResolvedValueOnce({ status: 'error', code: -1, name: 'Invalid_Key', message: 'Invalid API key' });

		await expect(
			plugin.sendEmail(
				{ from: 'a@x.com', to: ['b@x.com'], subject: 's', bodyText: 't', messageRef: 'r-err' },
				{ userId: 'u' }
			)
		).rejects.toThrow(/Invalid_Key.*Invalid API key/);
	});

	it('serves a repeated messageRef from the idempotency cache', async () => {
		sendMock.mockResolvedValue([{ email: 'b@x.com', status: 'sent', _id: 'mand-cache' }]);
		const input = { from: 'a@x.com', to: ['b@x.com'], subject: 's', bodyText: 't', messageRef: 'r-cache' };
		await plugin.sendEmail(input, { userId: 'u' });
		await plugin.sendEmail(input, { userId: 'u' });
		expect(sendMock).toHaveBeenCalledTimes(1);
	});
});
