/**
 * `src/mail.mjs` and `POST /mail/test` — the `smtp` dependency of the App spec.
 *
 * The blueprint README's row is "POST /mail/test → a message reaches the mail sink", so this test
 * stands up a real SMTP conversation on a socket and reads the message back out of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeSmtp } from './helpers/fake-smtp.mjs';
import { baseEnv, startDatabase, withServer } from './helpers/harness.mjs';
import { buildMessage, sendMail, smtpConfig } from '../src/mail.mjs';

test('smtpConfig reads the names the App spec binds, and is null without SMTP_HOST', () => {
	assert.equal(smtpConfig({}), null);
	const config = smtpConfig({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '2525', SMTP_USER: 'u', SMTP_PASSWORD: 'p', SMTP_FROM: 'Fixture <f@example.test>' });
	assert.deepEqual(
		{ host: config.host, port: config.port, user: config.user, secure: config.secure, from: config.from },
		{ host: 'smtp.example.test', port: 2525, user: 'u', secure: false, from: 'Fixture <f@example.test>' }
	);
	assert.equal(smtpConfig({ SMTP_HOST: 'h' }).port, 587, 'the submission port is the default');
	assert.equal(smtpConfig({ SMTP_HOST: 'h', SMTP_SECURE: '1' }).secure, true);
});

test('buildMessage produces CRLF headers and dot-stuffs the body', () => {
	const message = buildMessage('from@example.test', { to: 'to@example.test', subject: 'hello', text: 'line one\n.hidden\nline three' });
	assert.ok(message.includes('\r\nSubject: hello\r\n'));
	assert.ok(message.includes('\r\n\r\nline one\r\n..hidden\r\nline three'), 'a leading dot is stuffed so DATA cannot end early');
});

test('sendMail delivers one message through a real SMTP conversation', async (t) => {
	const smtp = createFakeSmtp({ user: 'smtp-user', password: 'smtp-password' });
	const port = await smtp.listen(0);
	t.after(() => smtp.close());

	const result = await sendMail(
		{ host: '127.0.0.1', port, user: 'smtp-user', password: 'smtp-password', from: 'fixture@example.test', timeoutMs: 3_000 },
		{ to: 'sink@example.test', subject: 'app-fixture-hello smoke test', text: 'marker: run-unique-marker' }
	);

	assert.equal(result.accepted, true);
	assert.equal(smtp.messages.length, 1);
	const [message] = smtp.messages;
	assert.equal(message.from, 'fixture@example.test');
	assert.deepEqual(message.to, ['sink@example.test']);
	assert.match(message.data, /Subject: app-fixture-hello smoke test/);
	assert.match(message.data, /marker: run-unique-marker/);
	assert.equal(smtp.sessions[0].auth.user, 'smtp-user');
});

test('sendMail refuses a server that rejects the credentials', async (t) => {
	const smtp = createFakeSmtp({ user: 'smtp-user', password: 'the-right-one' });
	const port = await smtp.listen(0);
	t.after(() => smtp.close());

	await assert.rejects(
		() =>
			sendMail(
				{ host: '127.0.0.1', port, user: 'smtp-user', password: 'the-wrong-one', from: 'fixture@example.test', timeoutMs: 3_000 },
				{ to: 'sink@example.test', subject: 'x', text: 'y' }
			),
		/535|Authentication/
	);
});

test('sendMail fails fast when nothing is listening', async () => {
	await assert.rejects(
		() => sendMail({ host: '127.0.0.1', port: 1, from: 'a@example.test', timeoutMs: 1_000 }, { to: 'b@example.test', subject: 'x', text: 'y' }),
		(error) => {
			assert.ok(error instanceof Error);
			return true;
		}
	);
});

test('POST /mail/test sends to the prompted address and answers 202', async (t) => {
	const smtp = createFakeSmtp();
	const port = await smtp.listen(0);
	t.after(() => smtp.close());
	const database = await startDatabase();
	t.after(() => database.close());

	const env = baseEnv({
		DATABASE_URL: database.url,
		SMTP_HOST: '127.0.0.1',
		SMTP_PORT: String(port),
		SMTP_FROM: 'fixture@example.test',
		FIXTURE_MAIL_TO: 'run-sink@example.test',
		FIXTURE_MAIL_RATE_LIMIT_MS: '0'
	});

	await withServer(env, async ({ request }) => {
		const response = await request('/mail/test', { method: 'POST' });
		assert.equal(response.status, 202);
		assert.equal(response.json.sent, true);
		assert.equal(response.json.to, 'run-sink@example.test');

		assert.equal(smtp.messages.length, 1);
		assert.equal(smtp.messages[0].to[0], 'run-sink@example.test');
		assert.match(smtp.messages[0].data, /test-marker/, 'the message carries the run marker');
	});
});

test('POST /mail/test is rate limited to one message a minute', async (t) => {
	const smtp = createFakeSmtp();
	const port = await smtp.listen(0);
	t.after(() => smtp.close());
	const database = await startDatabase();
	t.after(() => database.close());

	const env = baseEnv({
		DATABASE_URL: database.url,
		SMTP_HOST: '127.0.0.1',
		SMTP_PORT: String(port),
		FIXTURE_MAIL_TO: 'sink@example.test',
		FIXTURE_MAIL_RATE_LIMIT_MS: '60000'
	});

	await withServer(env, async ({ request }) => {
		assert.equal((await request('/mail/test', { method: 'POST' })).status, 202);
		const second = await request('/mail/test', { method: 'POST' });
		assert.equal(second.status, 429);
		assert.ok(second.headers.get('retry-after'));
		assert.equal(smtp.messages.length, 1, 'the second call sent nothing');
	});
});
