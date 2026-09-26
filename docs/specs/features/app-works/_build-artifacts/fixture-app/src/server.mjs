/**
 * The `web` component: `node src/server.mjs` on the port `.works/works.yml` declares (8080).
 *
 * The HTTP surface is exactly the one in the plan's §4.2 table, and every route exists to make one App
 * spec feature observable from outside the cluster:
 *
 *   GET  /            the greeting an agent changes   (evolve loop)
 *   GET  /healthz     200 with no database at all     (startup + liveness probes)
 *   GET  /readyz      503 until migrated              (readiness probe)
 *   GET  /marker      marker, commit, build label, public URL
 *   GET  /state       migrations, heartbeat, cron ticks, bootstrap, uploads, secret fingerprint
 *   POST /cron/tick   Bearer FIXTURE_CRON_TOKEN, else 401
 *   POST /mail/test   one message to FIXTURE_MAIL_TO, at most once a minute
 *   GET  /brand/*     the protected branding asset
 *
 * Node built-ins only: `node:http` is the whole framework.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { greeting, homePage } from './greeting.mjs';
import { fingerprint, safeEqual } from './fingerprint.mjs';
import { collectState } from './state.mjs';
import { bumpTick, connect, listAppliedMigrations, migrationFiles } from './db.mjs';
import { sendMail, smtpConfig } from './mail.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{env?: NodeJS.ProcessEnv, rootDir?: string, logger?: (line: object) => void}} [options]
 */
export function createServer(config = loadConfig(), options = {}) {
	const env = options.env ?? process.env;
	const appRoot = options.rootDir ?? rootDir;
	const log = options.logger ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));

	/** One lazily opened connection, dropped whenever a query fails. */
	let client = null;
	let mailLastSentAt = 0;
	let mailSent = 0;
	let mailLastError = null;

	async function db() {
		if (!config.databaseUrl) return null;
		if (client && client.connected) return client;
		client = await connect(env);
		return client;
	}

	function dropDb() {
		const dying = client;
		client = null;
		dying?.end().catch(() => undefined);
	}

	/** `200` once the database answers and every file in `migrations/` is applied; `503` otherwise. */
	async function readiness() {
		const expected = migrationFiles(path.join(appRoot, 'migrations')).map((file) => file.name);
		if (!config.databaseUrl) {
			return { ready: false, reason: 'DATABASE_URL is not configured', expected, applied: [], pending: expected };
		}
		try {
			// ONE statement on ONE fresh connection, and no throwaway ping before it. Two reasons:
			// the ping proved nothing the migration read does not, and the protocol stub this fixture is
			// tested against returns zero rows for every statement after the first on a connection — which
			// is what made `/readyz` report `applied: []` while `/state`, on its own connection, listed the
			// same three migrations. The fixture implements no pooling by design, so a connection per read is
			// the honest shape; see `evidence/proof.txt` §3.
			const connection = await connect(env);
			try {
				const details = await listAppliedMigrations(connection);
				const applied = details.filter((row) => row.label === 'app').map((row) => row.file);
				const pending = expected.filter((name) => !applied.includes(name));
				if (pending.length) {
					return { ready: false, reason: `not migrated: ${pending.join(', ')}`, expected, applied, pending };
				}
				return { ready: true, reason: 'database reachable and every migration applied', expected, applied, pending };
			} finally {
				await connection.end().catch(() => undefined);
			}
		} catch (error) {
			dropDb();
			return {
				ready: false,
				reason: error instanceof Error ? error.message : String(error),
				expected,
				applied: [],
				pending: expected
			};
		}
	}

	const server = http.createServer((req, res) => {
		const started = Date.now();
		res.on('finish', () => {
			log({ t: new Date().toISOString(), method: req.method, path: req.url, status: res.statusCode, ms: Date.now() - started });
		});
		handle(req, res).catch((error) => {
			sendJson(res, 500, { error: 'internal error', detail: error instanceof Error ? error.message : String(error) });
		});
	});

	/** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
	async function handle(req, res) {
		const url = new URL(req.url ?? '/', 'http://internal');
		const route = `${req.method} ${url.pathname}`;

		switch (route) {
			case 'GET /':
				return sendHtml(res, 200, homePage({ publicUrl: resolvePublicUrl(config, req) }));

			case 'GET /healthz':
				return sendText(res, 200, 'ok');

			case 'GET /readyz': {
				const state = await readiness();
				return sendJson(res, state.ready ? 200 : 503, state);
			}

			case 'GET /marker':
				return sendJson(res, 200, {
					marker: config.marker,
					sha: config.gitSha,
					buildLabel: config.buildLabel,
					publicUrl: resolvePublicUrl(config, req),
					greeting
				});

			case 'GET /state': {
				const state = await collectState(config, { env, rootDir: appRoot });
				state.mail = { configured: Boolean(smtpConfig(env)), to: config.mailTo || null, sent: mailSent, lastSentAt: mailLastSentAt ? new Date(mailLastSentAt).toISOString() : null, lastError: mailLastError };
				return sendJson(res, 200, state);
			}

			case 'POST /cron/tick':
				return cronTick(req, res);

			case 'POST /mail/test':
				return mailTest(req, res);

			default:
				break;
		}

		if (route === 'GET /favicon.ico') return sendText(res, 404, 'not found');
		if (req.method === 'GET' && url.pathname.startsWith('/brand/')) return servePublic(res, appRoot, url.pathname);
		if (isKnownPath(url.pathname)) return sendJson(res, 405, { error: 'method not allowed', allow: allowedMethods(url.pathname) });
		return sendJson(res, 404, { error: 'not found', path: url.pathname });
	}

	/** The scheduled call of `.works/works.yml` (`authScheme: bearer`) — anonymous calls are refused. */
	async function cronTick(req, res) {
		const header = req.headers.authorization ?? '';
		const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
		if (!config.cronToken || !safeEqual(token, config.cronToken)) {
			return sendJson(res, 401, { error: 'unauthorized', detail: 'POST /cron/tick needs Authorization: Bearer <FIXTURE_CRON_TOKEN>' });
		}
		try {
			const connection = await db();
			if (!connection) return sendJson(res, 503, { error: 'no database', detail: 'DATABASE_URL is not configured' });
			const tick = await bumpTick(connection, config.cronName);
			return sendJson(res, 204, null, { 'x-fixture-cron-ticks': String(tick?.ticks ?? '') });
		} catch (error) {
			dropDb();
			return sendJson(res, 503, { error: 'could not record the tick', detail: error instanceof Error ? error.message : String(error) });
		}
	}

	/** One message per minute at most (plan §4.2). `503` when the fixture has no SMTP dependency. */
	async function mailTest(req, res) {
		const smtp = smtpConfig(env);
		if (!smtp || !config.mailTo) {
			return sendJson(res, 503, {
				error: 'no smtp',
				detail: smtp ? 'FIXTURE_MAIL_TO is not set' : 'SMTP_HOST is not set (the smtp dependency is missing)'
			});
		}
		const since = Date.now() - mailLastSentAt;
		if (config.mailRateLimitMs > 0 && mailLastSentAt && since < config.mailRateLimitMs) {
			const retryAfter = Math.ceil((config.mailRateLimitMs - since) / 1000);
			return sendJson(res, 429, { error: 'rate limited', detail: 'at most one message a minute', retryAfterSeconds: retryAfter }, { 'retry-after': String(retryAfter) });
		}
		mailLastSentAt = Date.now();
		try {
			const result = await sendMail(smtp, {
				to: config.mailTo,
				subject: config.mailSubject,
				text: `app-fixture-hello\nmarker: ${config.marker}\nsha: ${config.gitSha}\nsent: ${new Date().toISOString()}\n`
			});
			mailSent += 1;
			mailLastError = null;
			return sendJson(res, 202, { sent: true, to: config.mailTo, replies: result.replies });
		} catch (error) {
			mailLastError = error instanceof Error ? error.message : String(error);
			return sendJson(res, 502, { error: 'smtp failed', detail: mailLastError });
		}
	}

	/** @param {string} pathname */
	function servePublic(res, appRoot, pathname) {
		const publicDir = path.join(appRoot, 'public');
		const target = path.join(publicDir, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
		if (!target.startsWith(publicDir) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
			return sendJson(res, 404, { error: 'not found', path: pathname });
		}
		const body = fs.readFileSync(target);
		res.writeHead(200, {
			'content-type': contentType(target),
			'content-length': body.length,
			'cache-control': 'public, max-age=300'
		});
		res.end(body);
	}

	return {
		server,
		readiness,
		/** Stop accepting connections, let in-flight requests finish, then close the database. */
		async close({ graceMs = config.shutdownGraceMs } = {}) {
			await new Promise((resolve) => {
				server.close(() => resolve());
				setTimeout(() => {
					server.closeAllConnections?.();
					resolve();
				}, graceMs).unref?.();
			});
			const dying = client;
			client = null;
			await dying?.end().catch(() => undefined);
		},
		/** @param {number} [port] @param {string} [host] */
		listen(port = config.port, host = config.host) {
			return new Promise((resolve, reject) => {
				server.once('error', reject);
				server.listen(port, host, () => {
					server.off('error', reject);
					resolve(server.address());
				});
			});
		}
	};
}

/**
 * `FIXTURE_PUBLIC_URL` is the App spec's `domains.primary.url` binding, so it is never baked into the
 * image (ACC-NEG-11). When it is unset — a local run, or a component reached by its service name — the
 * request's own `Host` header is the honest answer, and an empty string is the honest answer when
 * there is no `Host` either.
 * @param {ReturnType<typeof loadConfig>} config @param {http.IncomingMessage} [req]
 */
export function resolvePublicUrl(config, req) {
	const fromEnv = config.publicUrl;
	if (fromEnv) return fromEnv;
	const host = req?.headers?.host;
	return host ? `http://${host}` : '';
}

function isKnownPath(pathname) {
	return ['/', '/healthz', '/readyz', '/marker', '/state', '/cron/tick', '/mail/test'].includes(pathname);
}

function allowedMethods(pathname) {
	if (pathname === '/cron/tick' || pathname === '/mail/test') return ['POST'];
	return ['GET'];
}

function contentType(file) {
	if (file.endsWith('.svg')) return 'image/svg+xml';
	if (file.endsWith('.json')) return 'application/json; charset=utf-8';
	if (file.endsWith('.txt')) return 'text/plain; charset=utf-8';
	return 'application/octet-stream';
}

function sendJson(res, status, body, headers = {}) {
	if (body === null || status === 204) {
		res.writeHead(status, { 'content-length': '0', ...headers });
		return res.end();
	}
	const text = `${JSON.stringify(body, null, 2)}\n`;
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), ...headers });
	res.end(text);
}

function sendText(res, status, text) {
	res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
	res.end(text);
}

function sendHtml(res, status, html) {
	res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) });
	res.end(html);
}

/** True when this file is the program Node was asked to run (as opposed to an import from a test). */
export function isMain(metaUrl = import.meta.url, argv1 = process.argv[1]) {
	if (!argv1) return false;
	try {
		return metaUrl === pathToFileURL(argv1).href;
	} catch {
		return false;
	}
}

if (isMain()) {
	const config = loadConfig();
	const app = createServer(config);

	await app.listen();
	const address = app.server.address();
	process.stdout.write(
		`${JSON.stringify({
			t: new Date().toISOString(),
			event: 'listening',
			address: typeof address === 'object' && address ? `${address.address}:${address.port}` : String(address),
			sha: config.gitSha,
			buildLabel: config.buildLabel,
			markerSet: Boolean(config.marker),
			publicUrl: config.publicUrl,
			databaseConfigured: Boolean(config.databaseUrl),
			secretFingerprint: fingerprint(config.sessionSecret)
		})}\n`
	);

	let shuttingDown = false;
	for (const signal of ['SIGTERM', 'SIGINT']) {
		process.on(signal, () => {
			if (shuttingDown) return;
			shuttingDown = true;
			process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event: 'shutdown', signal })}\n`);
			app
				.close()
				.then(() => process.exit(0))
				.catch((error) => {
					process.stderr.write(`${JSON.stringify({ event: 'shutdown-failed', error: String(error) })}\n`);
					process.exit(1);
				});
		});
	}
}
