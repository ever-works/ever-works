import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMock = vi.fn();
const setApiKeyMock = vi.fn();

vi.mock('@sendgrid/mail', () => ({
	MailService: class {
		setApiKey = setApiKeyMock;
		send = sendMock;
	}
}));

import { SendGridPlugin } from './sendgrid-plugin.js';

describe('SendGridPlugin', () => {
	let plugin: SendGridPlugin;

	beforeEach(() => {
		plugin = new SendGridPlugin();
		process.env.SENDGRID_API_KEY = 'test-key';
		sendMock.mockReset();
		setApiKeyMock.mockReset();
	});

	it('declares the email-outbound capability', () => {
		expect(plugin.capabilities).toContain('email-outbound');
		expect(plugin.category).toBe('email-provider');
	});

	it('sends via @sendgrid/mail and reads the X-Message-Id header', async () => {
		sendMock.mockResolvedValueOnce([{ statusCode: 202, headers: { 'x-message-id': 'sg-msg-123' } }, {}]);

		const result = await plugin.sendEmail(
			{
				from: 'a@example.com',
				fromName: 'Agent',
				to: ['b@example.com'],
				subject: 'hi',
				bodyText: 'hi',
				bodyHtml: '<p>hi</p>',
				messageRef: 'ref-1'
			},
			{ userId: 'user-1' }
		);

		expect(result.providerMessageId).toBe('sg-msg-123');
		expect(result.accepted).toEqual(['b@example.com']);
		expect(setApiKeyMock).toHaveBeenCalledWith('test-key');
		const [msg, isMultiple] = sendMock.mock.calls[0];
		expect(isMultiple).toBe(false);
		expect(msg.from).toEqual({ email: 'a@example.com', name: 'Agent' });
		expect(msg.text).toBe('hi');
		expect(msg.html).toBe('<p>hi</p>');
	});

	it('wraps SendGrid SDK errors with the provider error messages', async () => {
		sendMock.mockRejectedValueOnce({
			code: 403,
			response: { body: { errors: [{ message: 'The from address does not match a verified Sender Identity.' }] } }
		});

		await expect(
			plugin.sendEmail(
				{ from: 'a@example.com', to: ['b@example.com'], subject: 'hi', bodyText: 'hi', messageRef: 'ref-err' },
				{ userId: 'u' }
			)
		).rejects.toThrow(/SendGrid send failed \(403\): The from address/);
	});

	it('serves a repeated messageRef from the idempotency cache without re-calling the SDK', async () => {
		sendMock.mockResolvedValue([{ statusCode: 202, headers: { 'x-message-id': 'sg-cache' } }, {}]);
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
		sendMock.mockResolvedValue([{ statusCode: 202, headers: { 'x-message-id': 'sg-scoped' } }, {}]);
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

	it('throws a clear error when no API key is configured', async () => {
		delete process.env.SENDGRID_API_KEY;
		await expect(
			plugin.sendEmail(
				{ from: 'a@example.com', to: ['b@example.com'], subject: 's', bodyText: 't', messageRef: 'r' },
				{ userId: 'u' }
			)
		).rejects.toThrow(/requires `apiKey`/);
	});
});

// No-op kept to avoid accidental global fetch leakage between suites.
function fetchSanityRestore(): void {}
