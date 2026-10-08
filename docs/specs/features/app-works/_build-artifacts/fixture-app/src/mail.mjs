/**
 * A minimal SMTP client over `node:net` / `node:tls` — Node built-ins only.
 *
 * `POST /mail/test` uses it to prove the `smtp` dependency end to end: the message must arrive in the
 * lane's mail sink (App spec `dependencies.smtp.required: true`). Supported: EHLO, STARTTLS, implicit
 * TLS, AUTH PLAIN and AUTH LOGIN. Not supported (deliberately): attachments, MIME bodies, pipelining,
 * DSN, and any form of retry — a fixture does not need them.
 */

import net from 'node:net';
import tls from 'node:tls';

export const DEFAULT_SMTP_TIMEOUT_MS = 10_000;

/** The App spec's `deps.smtp.*` outputs, under the names `spec.env` binds them to. `null` when unset. */
export function smtpConfig(env = process.env) {
	const host = env.SMTP_HOST;
	if (!host) return null;
	const port = Number(env.SMTP_PORT || 587);
	return {
		host,
		port: Number.isFinite(port) && port > 0 ? port : 587,
		user: env.SMTP_USER || '',
		password: env.SMTP_PASSWORD || '',
		from: env.SMTP_FROM || env.SMTP_USER || 'fixture@example.invalid',
		secure: String(env.SMTP_SECURE || '') === '1' || port === 465,
		requireTls: String(env.SMTP_REQUIRE_TLS || '') === '1',
		// Certificates are verified unless the operator opts out for a sink with a self-signed one.
		tlsRejectUnauthorized: String(env.SMTP_TLS_REJECT_UNAUTHORIZED ?? '') !== '0',
		timeoutMs: numberOr(env.FIXTURE_SMTP_TIMEOUT_MS, DEFAULT_SMTP_TIMEOUT_MS)
	};
}

/**
 * The TLS options for implicit TLS and for STARTTLS: the certificate is verified against `SMTP_HOST`
 * (`servername` doubles as SNI, which is never an IP address). Only an explicit
 * `SMTP_TLS_REJECT_UNAUTHORIZED=0` turns verification off, for a sink or relay whose certificate is
 * self-signed or issued by a private CA.
 *
 * Nothing on the platform guarantees today that an `smtp` dependency reading Ready presents a
 * certificate that verifies: the `smtp-external` / `platform-smtp-relay` readiness checks are
 * declared (provider ids and the `smtpTlsFailed` code in `@ever-works/contracts`) but not built yet.
 * A lane whose relay uses a private CA binds `SMTP_TLS_REJECT_UNAUTHORIZED` through the App spec env.
 *
 * What verification covers: a connection that negotiates TLS (implicit, or STARTTLS when the server
 * offers it) talks to the named host, so a man in the middle cannot read the AUTH credentials on it.
 * What it does not cover: an active attacker who removes `STARTTLS` from the EHLO reply — see
 * {@link sendMail}; `SMTP_REQUIRE_TLS=1` closes that.
 * @param {{host: string, tlsRejectUnauthorized?: boolean}} config
 */
export function smtpTlsOptions(config) {
	/** @type {import('node:tls').ConnectionOptions} */
	const options = { host: config.host, rejectUnauthorized: config.tlsRejectUnauthorized !== false };
	if (!net.isIP(config.host)) options.servername = config.host;
	return options;
}

export class SmtpError extends Error {
	constructor(message, code) {
		super(message);
		this.name = 'SmtpError';
		this.code = code;
	}
}

class SmtpSession {
	#socket;
	#buffer = '';
	#queue = [];
	#lines = [];
	#failures = [];

	constructor(socket) {
		this.#socket = socket;
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => {
			this.#buffer += chunk;
			let index = this.#buffer.indexOf('\n');
			while (index !== -1) {
				this.#lines.push(this.#buffer.slice(0, index).replace(/\r$/, ''));
				this.#buffer = this.#buffer.slice(index + 1);
				index = this.#buffer.indexOf('\n');
			}
			const waiter = this.#queue.shift();
			if (waiter) waiter();
		});
		socket.on('error', (error) => this.#fail(error));
		socket.on('close', () => this.#fail(new SmtpError('the server closed the connection', 'ECONNCLOSED')));
	}

	#fail(error) {
		this.#failures.push(error instanceof Error ? error : new Error(String(error)));
		while (this.#queue.length) this.#queue.shift()();
	}

	/** One complete reply: its code and every line, `250-STARTTLS` continuations included. */
	async readReply() {
		const lines = [];
		for (;;) {
			while (this.#lines.length === 0) {
				if (this.#failures.length) throw this.#failures[0];
				await new Promise((resolve) => this.#queue.push(resolve));
			}
			const line = this.#lines.shift();
			lines.push(line);
			if (/^\d{3} /.test(line)) break;
		}
		const code = Number.parseInt(lines[lines.length - 1].slice(0, 3), 10);
		return { code, lines };
	}

	async command(text, expected = [250]) {
		this.#socket.write(`${text}\r\n`);
		const reply = await this.readReply();
		if (expected.length && !expected.includes(reply.code)) {
			throw new SmtpError(`${text.split(' ')[0]} answered ${reply.code}: ${reply.lines.join(' | ')}`, `SMTP_${reply.code}`);
		}
		return reply;
	}

	async write(text) {
		this.#socket.write(text);
	}

	/** STARTTLS: wrap the plain socket; `tlsOptions` carries the host the certificate must name. */
	async upgrade(tlsOptions) {
		const upgraded = await new Promise((resolve, reject) => {
			const secure = tls.connect({ ...tlsOptions, socket: this.#socket });
			secure.once('secureConnect', () => resolve(secure));
			secure.once('error', reject);
		});
		this.#socket = upgraded;
		this.#buffer = '';
		this.#lines = [];
		upgraded.setEncoding('utf8');
		upgraded.on('data', (chunk) => {
			this.#buffer += chunk;
			let index = this.#buffer.indexOf('\n');
			while (index !== -1) {
				this.#lines.push(this.#buffer.slice(0, index).replace(/\r$/, ''));
				this.#buffer = this.#buffer.slice(index + 1);
				index = this.#buffer.indexOf('\n');
			}
			const waiter = this.#queue.shift();
			if (waiter) waiter();
		});
		upgraded.on('error', (error) => this.#fail(error));
		upgraded.on('close', () => this.#fail(new SmtpError('the server closed the connection', 'ECONNCLOSED')));
	}

	close() {
		try {
			this.#socket.end();
		} catch {
			/* already gone */
		}
		setTimeout(() => this.#socket.destroy(), 200).unref?.();
	}
}

/**
 * Deliver one plain-text message.
 *
 * STARTTLS is opportunistic by default, as it is in nodemailer: a server that does not offer it is
 * spoken to in the clear, AUTH included. That keeps the acceptance lane working — its mail sink is
 * MailHog-compatible and offers no TLS (ACCEPTANCE.md) — but it means an active attacker who strips
 * `STARTTLS` from the EHLO reply can read the credentials. `SMTP_REQUIRE_TLS=1` refuses that session
 * before AUTH is sent; bind it wherever the SMTP credentials are real.
 * @param {{host: string, port: number, user?: string, password?: string, from: string, secure?: boolean,
 *          requireTls?: boolean, tlsRejectUnauthorized?: boolean, timeoutMs?: number}} config
 * @param {{to: string, subject: string, text: string}} message
 * @returns {Promise<{accepted: boolean, replies: string[]}>}
 */
export async function sendMail(config, message) {
	const timeoutMs = config.timeoutMs || DEFAULT_SMTP_TIMEOUT_MS;
	const socket = config.secure
		? tls.connect({ ...smtpTlsOptions(config), port: config.port })
		: net.connect({ host: config.host, port: config.port });
	socket.setTimeout(timeoutMs, () => socket.destroy(new SmtpError(`the SMTP server did not answer within ${timeoutMs} ms`, 'ETIMEDOUT')));
	const session = new SmtpSession(socket);
	const replies = [];
	try {
		await new Promise((resolve, reject) => {
			socket.once(config.secure ? 'secureConnect' : 'connect', resolve);
			socket.once('error', reject);
		});
		replies.push(describe(await session.readReply()));

		let ehlo = await session.command(`EHLO ${config.heloName || 'app-fixture-hello'}`, [250]);
		replies.push(describe(ehlo));

		if (!config.secure) {
			const offersStartTls = ehlo.lines.some((line) => /STARTTLS/i.test(line));
			if (offersStartTls) {
				replies.push(describe(await session.command('STARTTLS', [220])));
				await session.upgrade(smtpTlsOptions(config));
				ehlo = await session.command(`EHLO ${config.heloName || 'app-fixture-hello'}`, [250]);
				replies.push(describe(ehlo));
			} else if (config.requireTls) {
				throw new SmtpError('the server does not offer STARTTLS and SMTP_REQUIRE_TLS is set', 'ENOTLS');
			}
		}

		if (config.user) {
			const mechanisms = (ehlo.lines.find((line) => /AUTH/i.test(line)) || '').toUpperCase();
			if (mechanisms.includes('PLAIN')) {
				const token = Buffer.from(`\0${config.user}\0${config.password || ''}`, 'utf8').toString('base64');
				replies.push(describe(await session.command(`AUTH PLAIN ${token}`, [235])));
			} else {
				replies.push(describe(await session.command('AUTH LOGIN', [334])));
				replies.push(describe(await session.command(Buffer.from(config.user, 'utf8').toString('base64'), [334])));
				replies.push(describe(await session.command(Buffer.from(config.password || '', 'utf8').toString('base64'), [235])));
			}
		}

		replies.push(describe(await session.command(`MAIL FROM:<${config.from}>`, [250])));
		replies.push(describe(await session.command(`RCPT TO:<${message.to}>`, [250, 251])));
		replies.push(describe(await session.command('DATA', [354])));
		await session.write(`${buildMessage(config.from, message)}\r\n.\r\n`);
		replies.push(describe(await session.readReply()));
		await session.command('QUIT', [221]).catch(() => undefined);
		return { accepted: true, replies };
	} finally {
		session.close();
	}
}

/** RFC 5322 message with CRLF line endings and dot-stuffing, as `DATA` requires. */
export function buildMessage(from, { to, subject, text }) {
	const headers = [
		`From: ${from}`,
		`To: ${to}`,
		`Subject: ${subject}`,
		`Date: ${new Date().toUTCString()}`,
		'Message-ID: <' + `${Date.now()}.${process.pid}@app-fixture-hello` + '>',
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=utf-8'
	];
	const body = String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
	return `${headers.join('\r\n')}\r\n\r\n${body}`;
}

function describe(reply) {
	return reply.lines.join(' | ');
}

function numberOr(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
