import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMock = vi.fn();

vi.mock('resend', () => ({
	Resend: class {
		emails = { send: sendMock };
	}
}));

import { ResendPlugin } from './resend-plugin.js';

describe('ResendPlugin', () => {
	let plugin: ResendPlugin;

	beforeEach(() => {
		plugin = new ResendPlugin();
		process.env.RESEND_API_KEY = 'test-key';
		sendMock.mockReset();
	});

	it('declares only email-outbound (inbound is private beta)', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.capabilities).not.toContain('email-inbound');
	});

	it('sends via the resend SDK with an idempotency key and returns the id', async () => {
		sendMock.mockResolvedValueOnce({ data: { id: 'rs-abc-123' }, error: null });

		const result = await plugin.sendEmail(
			{ from: 'a@example.com', to: ['b@example.com'], subject: 'hi', bodyText: 'hi', messageRef: 'ref-1' },
			{ userId: 'user-1' }
		);

		expect(result.providerMessageId).toBe('rs-abc-123');
		const [payload, opts] = sendMock.mock.calls[0];
		expect(payload.to).toEqual(['b@example.com']);
		expect(payload.text).toBe('hi');
		expect(opts).toEqual({ idempotencyKey: 'ref-1' });
	});

	it('throws when the resend SDK returns an error', async () => {
		sendMock.mockResolvedValueOnce({
			data: null,
			error: { name: 'validation_error', message: 'Invalid sender' }
		});

		await expect(
			plugin.sendEmail(
				{ from: 'a@example.com', to: ['b@example.com'], subject: 'hi', bodyText: 'hi', messageRef: 'ref-err' },
				{ userId: 'u' }
			)
		).rejects.toThrow(/Resend send failed \(validation_error\): Invalid sender/);
	});

	it('serves repeated messageRef from the idempotency cache without re-calling the SDK', async () => {
		sendMock.mockResolvedValue({ data: { id: 'rs-cache' }, error: null });

		const input = {
			from: 'a@example.com',
			to: ['b@example.com'],
			subject: 'hi',
			bodyText: 'hi',
			messageRef: 'ref-cache'
		};
		await plugin.sendEmail(input, { userId: 'u' });
		await plugin.sendEmail(input, { userId: 'u' });
		expect(sendMock).toHaveBeenCalledTimes(1);
	});

	it('does NOT serve a cached result across different userIds (tenant isolation)', async () => {
		// Security: the local idempotency cache key is scoped by
		// options.userId/workId — the same messageRef from two different users
		// must trigger two real sends, never leak user A's cached result to B.
		sendMock.mockResolvedValue({ data: { id: 'rs-scoped' }, error: null });

		const input = {
			from: 'a@example.com',
			to: ['b@example.com'],
			subject: 'hi',
			bodyText: 'hi',
			messageRef: 'ref-shared'
		};
		await plugin.sendEmail(input, { userId: 'user-a' });
		await plugin.sendEmail(input, { userId: 'user-b' });
		expect(sendMock).toHaveBeenCalledTimes(2);
	});
});
