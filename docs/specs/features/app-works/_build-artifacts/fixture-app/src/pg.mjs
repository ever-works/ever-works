/**
 * A minimal PostgreSQL frontend: the v3 wire protocol, in Node built-ins only.
 *
 * The fixture deliberately carries no runtime dependency (see gaps.md §1), so this file replaces the
 * `pg` client the plan's layout table names. It implements exactly what the fixture needs and nothing
 * else:
 *
 *   - startup, with `sslmode` (`disable` | `prefer` | `require`) and the `PG*` environment fallback
 *   - authentication: AuthenticationOk, cleartext, MD5 and SCRAM-SHA-256 (Postgres 14+ default)
 *   - the simple query protocol (several statements per message, used by `migrations/*.sql`)
 *   - the extended query protocol with text parameters (`Parse`/`Bind`/`Describe`/`Execute`/`Sync`)
 *   - text-format result decoding for the handful of types the fixture reads
 *   - one serialised request queue, a connect timeout and a per-query timeout
 *
 * Not implemented on purpose: COPY, LISTEN/NOTIFY (notifications are dropped), binary result formats,
 * prepared-statement caching, connection pooling and channel binding (SCRAM-SHA-256-PLUS is refused).
 * `test/pg.test.mjs` exercises this client against a protocol-level stub. **No real-PostgreSQL run is
 * recorded in this repository** — an earlier version of this comment said otherwise. Set
 * `FIXTURE_TEST_DATABASE_URL` to run it against a real PostgreSQL 16 server; that is the run the
 * acceptance lanes owe, and until it happens this client is proven only against the stub.
 */

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_QUERY_TIMEOUT_MS = 15_000;

/** Result type OIDs the fixture decodes; every other type is returned as text (as PostgreSQL sends it). */
const OID_BOOL = 16;
const OID_INT8 = 20;
const OID_INT2 = 21;
const OID_INT4 = 23;
const OID_FLOAT4 = 700;
const OID_FLOAT8 = 701;
const OID_NUMERIC = 1700;

export class PgError extends Error {
	/** @param {Record<string, string>} fields ErrorResponse fields, keyed by their protocol letter. */
	constructor(fields) {
		super(fields.M || 'PostgreSQL error');
		this.name = 'PgError';
		/** SQLSTATE, e.g. `42601` for a syntax error. */
		this.code = fields.C || '';
		this.severity = fields.S || 'ERROR';
		this.detail = fields.D;
		this.hint = fields.H;
		this.where = fields.W;
		this.fields = fields;
	}
}

/**
 * Split a `postgres://` URL (or fall back to the libpq `PG*` variables) into connection settings.
 * @param {string} [url]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseDatabaseUrl(url, env = process.env) {
	if (!url) {
		if (!env.PGHOST && !env.PGDATABASE && !env.PGUSER) return null;
		return {
			host: env.PGHOST || '127.0.0.1',
			port: Number(env.PGPORT || 5432),
			user: env.PGUSER || 'postgres',
			password: env.PGPASSWORD || '',
			database: env.PGDATABASE || env.PGUSER || 'postgres',
			sslmode: env.PGSSLMODE || 'prefer',
			applicationName: env.PGAPPNAME || 'app-fixture-hello'
		};
	}

	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`DATABASE_URL is not a URL: ${redactUrl(url)}`);
	}
	if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
		throw new Error(`DATABASE_URL must start with postgres:// (got ${parsed.protocol}//)`);
	}
	const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || parsed.username || 'postgres';
	return {
		host: parsed.hostname || '127.0.0.1',
		port: Number(parsed.port || 5432),
		user: decodeURIComponent(parsed.username || 'postgres'),
		password: decodeURIComponent(parsed.password || ''),
		database,
		sslmode: parsed.searchParams.get('sslmode') || 'prefer',
		applicationName: parsed.searchParams.get('application_name') || 'app-fixture-hello',
		connectTimeoutMs: numberOr(parsed.searchParams.get('connect_timeout'), null) != null
			? Number(parsed.searchParams.get('connect_timeout')) * 1000
			: undefined
	};
}

/** Hide the password of a connection URL so it can go into a log line or an HTTP response. */
export function redactUrl(url) {
	return String(url).replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@');
}

function numberOr(value, fallback) {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

const cstring = (buf, offset) => {
	const end = buf.indexOf(0, offset);
	if (end === -1) return { value: buf.subarray(offset).toString('utf8'), next: buf.length };
	return { value: buf.subarray(offset, end).toString('utf8'), next: end + 1 };
};

function decodeValue(oid, text) {
	switch (oid) {
		case OID_BOOL:
			return text === 't';
		case OID_INT2:
		case OID_INT4:
			return Number.parseInt(text, 10);
		case OID_INT8: {
			const n = Number.parseInt(text, 10);
			return Number.isSafeInteger(n) ? n : text;
		}
		case OID_FLOAT4:
		case OID_FLOAT8:
		case OID_NUMERIC: {
			const n = Number(text);
			return Number.isFinite(n) ? n : text;
		}
		default:
			return text;
	}
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const xor = (a, b) => Buffer.from(a.map((byte, i) => byte ^ b[i]));
const saslEscape = (value) => String(value).replace(/=/g, '=3D').replace(/,/g, '=2C');

const md5 = (data) => crypto.createHash('md5').update(data).digest('hex');

export class PgClient {
	#socket = null;
	#buffer = Buffer.alloc(0);
	#messages = [];
	#dataWaiter = null;
	#failure = null;
	#closed = false;
	#lock = Promise.resolve();
	#serverParameters = {};
	#backendPid = null;

	/**
	 * @param {object} config
	 * @param {string} [config.url] `postgres://…` connection URL.
	 * @param {string} [config.host] @param {number} [config.port] @param {string} [config.user]
	 * @param {string} [config.password] @param {string} [config.database] @param {string} [config.sslmode]
	 * @param {number} [config.connectTimeoutMs] @param {number} [config.queryTimeoutMs]
	 */
	constructor(config = {}) {
		const fromUrl = parseDatabaseUrl(config.url) ?? {};
		this.config = { ...fromUrl, ...stripUndefined(config), sslmode: config.sslmode ?? fromUrl.sslmode ?? 'prefer' };
		this.connectTimeoutMs = numberOr(this.config.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
		this.queryTimeoutMs = numberOr(this.config.queryTimeoutMs, DEFAULT_QUERY_TIMEOUT_MS);
	}

	/** @param {string} url */
	static fromUrl(url, extra = {}) {
		return new PgClient({ url, ...extra });
	}

	get connected() {
		return this.#socket !== null && !this.#closed;
	}

	get serverParameters() {
		return { ...this.#serverParameters };
	}

	/** Open the socket, authenticate and wait for ReadyForQuery. */
	async connect() {
		if (this.connected) return this;
		const { host, port, user, password, database, applicationName } = this.config;
		if (!host) throw new Error('pg: no host configured');

		const socket = await this.#openSocket(host, port);
		this.#socket = socket;
		socket.on('data', (chunk) => this.#onData(chunk));
		socket.on('error', (error) => this.#onFailure(error));
		socket.on('close', () => this.#onFailure(new Error('pg: connection closed by the server')));

		await this.#negotiateTls(socket, host);
		this.#sendStartup(user, database, applicationName);
		await this.#authenticate(password, user);
		await this.#readUntilReady();
		return this;
	}

	#openSocket(host, port) {
		return new Promise((resolve, reject) => {
			const socket = net.connect({ host, port: port || 5432 });
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error(`pg: connect timed out after ${this.connectTimeoutMs} ms (${host}:${port || 5432})`));
			}, this.connectTimeoutMs);
			socket.once('connect', () => {
				clearTimeout(timer);
				socket.setNoDelay(true);
				resolve(socket);
			});
			socket.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	async #negotiateTls(socket, host) {
		const sslmode = String(this.config.sslmode || 'prefer').toLowerCase();
		if (sslmode === 'disable' || sslmode === 'allow') return;
		const request = Buffer.alloc(8);
		request.writeInt32BE(8, 0);
		request.writeInt32BE(80877103, 4); // SSLRequest
		socket.write(request);
		const answer = await this.#readExact(socket, 1);
		if (answer[0] === 0x53 /* 'S' */) {
			const secure = await new Promise((resolve, reject) => {
				const upgraded = tls.connect({ socket, servername: host, rejectUnauthorized: false });
				upgraded.once('secureConnect', () => resolve(upgraded));
				upgraded.once('error', reject);
			});
			this.#socket = secure;
			secure.on('data', (chunk) => this.#onData(chunk));
			secure.on('error', (error) => this.#onFailure(error));
			secure.on('close', () => this.#onFailure(new Error('pg: connection closed by the server')));
			return;
		}
		if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') {
			throw new Error('pg: the server refused TLS but sslmode requires it');
		}
	}

	/** Read exactly `size` bytes from a raw socket (used only during the TLS handshake). */
	#readExact(socket, size) {
		return new Promise((resolve, reject) => {
			const chunks = [];
			let have = 0;
			const onData = (chunk) => {
				chunks.push(chunk);
				have += chunk.length;
				if (have >= size) {
					cleanup();
					resolve(Buffer.concat(chunks));
				}
			};
			const onError = (error) => {
				cleanup();
				reject(error);
			};
			const cleanup = () => {
				socket.off('data', onData);
				socket.off('error', onError);
			};
			socket.on('data', onData);
			socket.on('error', onError);
		});
	}

	#sendStartup(user, database, applicationName) {
		const params = {
			user: user || 'postgres',
			database: database || user || 'postgres',
			client_encoding: 'UTF8',
			application_name: applicationName || 'app-fixture-hello'
		};
		const parts = [Buffer.from([0, 3, 0, 0])]; // protocol 3.0
		for (const [key, value] of Object.entries(params)) {
			parts.push(Buffer.from(`${key}\0${value}\0`, 'utf8'));
		}
		parts.push(Buffer.from([0]));
		this.#write(Buffer.concat(parts), 'startup');
	}

	async #authenticate(password, user) {
		for (;;) {
			const message = await this.#next();
			switch (message.type) {
				case 'R':
					await this.#handleAuthentication(message.body, password, user);
					return;
				case 'E':
					throw parseErrorResponse(message.body);
				case 'Z':
					return; // trust authentication: ReadyForQuery straight away
				default:
					this.#handleAsync(message);
			}
		}
	}

	async #handleAuthentication(body, password, user) {
		const code = body.readInt32BE(0);
		if (code === 0) return; // AuthenticationOk
		if (code === 3) {
			if (!password) throw new Error('pg: the server asked for a password but none was configured');
			this.#write(Buffer.from(`${password}\0`, 'utf8'), 'p');
			await this.#expectAuthenticationOk();
			return;
		}
		if (code === 5) {
			if (!password) throw new Error('pg: the server asked for a password but none was configured');
			const salt = body.subarray(4, 8);
			const digest = md5(Buffer.concat([Buffer.from(md5(password + user), 'utf8'), salt]));
			this.#write(Buffer.from(`md5${digest}\0`, 'utf8'), 'p');
			await this.#expectAuthenticationOk();
			return;
		}
		if (code === 10) {
			if (!password) throw new Error('pg: the server asked for a password but none was configured');
			await this.#scramAuthenticate(body, password, user);
			return;
		}
		throw new Error(`pg: unsupported authentication request ${code}`);
	}

	async #expectAuthenticationOk() {
		for (;;) {
			const message = await this.#next();
			if (message.type === 'E') throw parseErrorResponse(message.body);
			if (message.type === 'R') {
				const code = message.body.readInt32BE(0);
				if (code === 0) return;
				throw new Error(`pg: unexpected authentication request ${code} after the password was sent`);
			}
			this.#handleAsync(message);
		}
	}

	/** SCRAM-SHA-256 (RFC 5802 / RFC 7677), the default of PostgreSQL 14 and later. */
	async #scramAuthenticate(body, password, user) {
		const mechanisms = [];
		let offset = 4;
		while (offset < body.length) {
			const read = cstring(body, offset);
			if (!read.value) break;
			mechanisms.push(read.value);
			offset = read.next;
		}
		if (!mechanisms.includes('SCRAM-SHA-256')) {
			throw new Error(`pg: no supported SASL mechanism (server offers ${mechanisms.join(', ') || 'none'})`);
		}

		const clientNonce = crypto.randomBytes(18).toString('base64');
		const clientFirstBare = `n=${saslEscape(user)},r=${clientNonce}`;
		const clientFirst = `n,,${clientFirstBare}`;
		this.#write(
			Buffer.concat([
				Buffer.from('SCRAM-SHA-256\0', 'utf8'),
				lengthPrefixed(Buffer.from(clientFirst, 'utf8'))
			]),
			'p'
		);

		const serverFirstMessage = await this.#expectSaslMessage(11);
		const attributes = parseScramAttributes(serverFirstMessage);
		const serverNonce = attributes.r;
		if (!serverNonce || !serverNonce.startsWith(clientNonce)) {
			throw new Error('pg: SCRAM server nonce does not extend the client nonce');
		}
		const salt = Buffer.from(attributes.s || '', 'base64');
		const iterations = Number.parseInt(attributes.i || '4096', 10);
		if (!salt.length || !Number.isFinite(iterations) || iterations < 1) {
			throw new Error('pg: SCRAM server-first-message is missing its salt or iteration count');
		}

		const saltedPassword = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
		const clientKey = hmac(saltedPassword, 'Client Key');
		const storedKey = sha256(clientKey);
		const clientFinalWithoutProof = `c=biws,r=${serverNonce}`;
		const authMessage = `${clientFirstBare},${serverFirstMessage},${clientFinalWithoutProof}`;
		const clientSignature = hmac(storedKey, authMessage);
		const clientProof = xor(clientKey, clientSignature).toString('base64');
		this.#write(Buffer.from(`${clientFinalWithoutProof},p=${clientProof}`, 'utf8'), 'p');

		const serverFinalMessage = await this.#expectSaslMessage(12);
		const finalAttributes = parseScramAttributes(serverFinalMessage);
		if (finalAttributes.e) throw new Error(`pg: SCRAM authentication failed: ${finalAttributes.e}`);
		const serverKey = hmac(saltedPassword, 'Server Key');
		const expectedSignature = hmac(serverKey, authMessage).toString('base64');
		if (finalAttributes.v !== expectedSignature) {
			throw new Error('pg: SCRAM server signature does not match — refusing the connection');
		}
		await this.#expectAuthenticationOk();
	}

	async #expectSaslMessage(expectedCode) {
		for (;;) {
			const message = await this.#next();
			if (message.type === 'E') throw parseErrorResponse(message.body);
			if (message.type !== 'R') {
				this.#handleAsync(message);
				continue;
			}
			const code = message.body.readInt32BE(0);
			if (code !== expectedCode) throw new Error(`pg: expected SASL message ${expectedCode}, got ${code}`);
			return message.body.subarray(4).toString('utf8');
		}
	}

	/**
	 * Run one or more statements through the simple query protocol.
	 * The SQL is sent verbatim, so it must never contain user input — use {@link query} for that.
	 * @param {string} sql
	 * @returns {Promise<{ statements: Array<{ command: string, rowCount: number|null, rows: unknown[] }>, rows: unknown[], command: string, rowCount: number|null, fields: unknown[] }>}
	 */
	async simpleQuery(sql) {
		return this.#serialise(async () => {
			this.#write(Buffer.from(`${sql}\0`, 'utf8'), 'Q');
			const collected = await this.#readUntilReady();
			if (collected.error) throw collected.error;
			const statements = collected.results;
			const last = statements[statements.length - 1] || { rows: [], command: '', rowCount: null, fields: [] };
			return { statements, rows: last.rows, command: last.command, rowCount: last.rowCount, fields: last.fields };
		});
	}

	/**
	 * Run one statement through the extended query protocol with text parameters.
	 * @param {string} text SQL with `$1`-style placeholders.
	 * @param {unknown[]} [values]
	 */
	async query(text, values = []) {
		return this.#serialise(async () => {
			const parse = Buffer.concat([Buffer.from('\0', 'utf8'), Buffer.from(`${text}\0`, 'utf8'), Buffer.from([0, 0])]);
			this.#write(parse, 'P');
			const bind = Buffer.concat([
				Buffer.from('\0\0', 'utf8'), // unnamed portal, unnamed statement
				Buffer.from([0, 0]), // no parameter format codes (all text)
				uint16(values.length),
				...values.map((value) => encodeParameter(value)),
				Buffer.from([0, 0]) // all results in text format
			]);
			this.#write(bind, 'B');
			this.#write(Buffer.concat([Buffer.from('P\0', 'utf8')]), 'D'); // describe the portal
			this.#write(Buffer.concat([Buffer.from('\0', 'utf8'), uint32(0)]), 'E'); // execute, no row limit
			this.#write(Buffer.alloc(0), 'S'); // sync
			const collected = await this.#readUntilReady();
			if (collected.error) throw collected.error;
			const last = collected.results[collected.results.length - 1] || { rows: [], command: '', rowCount: null, fields: [] };
			return { rows: last.rows, command: last.command, rowCount: last.rowCount, fields: last.fields };
		});
	}

	/** Send Terminate and close the socket. Safe to call twice. */
	async end() {
		if (!this.#socket || this.#closed) {
			this.#closed = true;
			return;
		}
		try {
			this.#write(Buffer.alloc(0), 'X');
		} catch {
			/* the socket may already be gone */
		}
		this.#closed = true;
		await new Promise((resolve) => {
			const socket = this.#socket;
			if (!socket || socket.destroyed) return resolve();
			socket.end(() => resolve());
			setTimeout(() => {
				socket.destroy();
				resolve();
			}, 250).unref?.();
		});
	}

	async #serialise(operation) {
		const run = this.#lock.then(operation, operation);
		this.#lock = run.then(
			() => undefined,
			() => undefined
		);
		return run;
	}

	#write(body, type) {
		const socket = this.#socket;
		if (!socket || this.#closed) throw new Error('pg: not connected');
		if (type === 'startup') {
			const header = Buffer.alloc(4);
			header.writeInt32BE(body.length + 4, 0);
			socket.write(Buffer.concat([header, body]));
			return;
		}
		const header = Buffer.alloc(5);
		header.write(type, 0, 'latin1');
		header.writeInt32BE(body.length + 4, 1);
		socket.write(Buffer.concat([header, body]));
	}

	#onData(chunk) {
		this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
		this.#drain();
		const waiter = this.#dataWaiter;
		if (waiter) {
			this.#dataWaiter = null;
			waiter();
		}
	}

	#onFailure(error) {
		if (this.#failure) return;
		this.#failure = error instanceof Error ? error : new Error(String(error));
		this.#closed = true;
		const waiter = this.#dataWaiter;
		if (waiter) {
			this.#dataWaiter = null;
			waiter();
		}
	}

	#drain() {
		while (this.#buffer.length >= 5) {
			const length = this.#buffer.readInt32BE(1);
			if (length < 4 || this.#buffer.length < length + 1) break;
			const type = String.fromCharCode(this.#buffer[0]);
			const body = this.#buffer.subarray(5, length + 1);
			this.#buffer = this.#buffer.subarray(length + 1);
			this.#messages.push({ type, body });
		}
	}

	async #next() {
		for (;;) {
			if (this.#messages.length) return this.#messages.shift();
			if (this.#failedNow()) throw this.#failure;
			if (this.#closed) throw new Error('pg: the connection was closed before the server answered');
			await new Promise((resolve) => {
				this.#dataWaiter = resolve;
			});
		}
	}

	/** A failure raised by an `E` message is terminal for the connection, but a plain socket close is not. */
	#failedNow() {
		return this.#failure !== null;
	}

	/** Read messages until ReadyForQuery, collecting result sets and remembering a protocol error. */
	async #readUntilReady() {
		const results = [];
		let current = null;
		let error = null;
		const deadline = Date.now() + this.queryTimeoutMs;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`pg: query timed out after ${this.queryTimeoutMs} ms`);
			const message = await this.#withTimeout(this.#next(), remaining);
			switch (message.type) {
				case 'T':
					current = { fields: parseRowDescription(message.body), rows: [], command: '', rowCount: null };
					results.push(current);
					break;
				case 'D':
					current?.rows.push(parseDataRow(message.body, current.fields));
					break;
				case 'C': {
					// A statement with no result columns (CREATE, INSERT, BEGIN, …) is announced only by its
					// CommandComplete, so it gets a result of its own with no fields and no rows.
					const result = current ?? { fields: [], rows: [], command: '', rowCount: null };
					if (!current) results.push(result);
					result.command = cstring(message.body, 0).value;
					result.rowCount = parseRowCount(result.command);
					current = null;
					break;
				}
				case 'I':
					results.push({ fields: [], rows: [], command: 'EMPTY', rowCount: null });
					break;
				case 'E':
					error = parseErrorResponse(message.body);
					break;
				case 'Z':
					return { results, error };
				case 'S':
					this.#serverParameters[cstring(message.body, 0).value] = cstring(message.body, cstring(message.body, 0).next).value;
					break;
				case 'K':
					this.#backendPid = message.body.readInt32BE(0);
					break;
				case 'N':
				case 'A':
					break; // notices and notifications are dropped on purpose
				case '1':
					break; // ParseComplete
				case '2':
					break; // BindComplete
				case '3':
					break; // CloseComplete
				case 'n':
					break; // NoData
				default:
					break;
			}
		}
	}

	#handleAsync(message) {
		if (message.type === 'S') {
			const key = cstring(message.body, 0);
			this.#serverParameters[key.value] = cstring(message.body, key.next).value;
		}
	}

	#withTimeout(promise, ms) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`pg: timed out after ${ms} ms`)), ms);
			timer.unref?.();
			promise.then(
				(value) => {
					clearTimeout(timer);
					resolve(value);
				},
				(error) => {
					clearTimeout(timer);
					reject(error);
				}
			);
		});
	}
}

function stripUndefined(object) {
	return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));
}

function uint16(value) {
	const buffer = Buffer.alloc(2);
	buffer.writeUInt16BE(value, 0);
	return buffer;
}

function uint32(value) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(value, 0);
	return buffer;
}

function lengthPrefixed(buffer) {
	return Buffer.concat([uint32(buffer.length), buffer]);
}

function encodeParameter(value) {
	if (value === null || value === undefined) return uint32(0xffffffff); // NULL
	if (value instanceof Date) return lengthPrefixed(Buffer.from(value.toISOString(), 'utf8'));
	if (typeof value === 'boolean') return lengthPrefixed(Buffer.from(value ? 'true' : 'false', 'utf8'));
	if (Buffer.isBuffer(value)) return lengthPrefixed(value);
	return lengthPrefixed(Buffer.from(String(value), 'utf8'));
}

function parseScramAttributes(message) {
	const attributes = {};
	for (const part of String(message).split(',')) {
		const index = part.indexOf('=');
		if (index > 0) attributes[part.slice(0, index)] = part.slice(index + 1);
	}
	return attributes;
}

function parseRowDescription(body) {
	const count = body.readUInt16BE(0);
	const fields = [];
	let offset = 2;
	for (let i = 0; i < count; i += 1) {
		const name = cstring(body, offset);
		offset = name.next;
		const tableOid = body.readUInt32BE(offset);
		const columnId = body.readInt16BE(offset + 4);
		const dataTypeOid = body.readUInt32BE(offset + 6);
		const typeSize = body.readInt16BE(offset + 10);
		const typeModifier = body.readInt32BE(offset + 12);
		const format = body.readInt16BE(offset + 16);
		offset += 18;
		fields.push({ name: name.value, tableOid, columnId, dataTypeOid, typeSize, typeModifier, format });
	}
	return fields;
}

function parseDataRow(body, fields) {
	const count = body.readUInt16BE(0);
	const row = {};
	let offset = 2;
	for (let i = 0; i < count; i += 1) {
		const length = body.readInt32BE(offset);
		offset += 4;
		const field = fields[i] || { name: `column${i + 1}`, dataTypeOid: 25 };
		if (length === -1) {
			row[field.name] = null;
			continue;
		}
		const text = body.subarray(offset, offset + length).toString('utf8');
		offset += length;
		row[field.name] = decodeValue(field.dataTypeOid, text);
	}
	return row;
}

function parseRowCount(tag) {
	const parts = String(tag).split(' ');
	const last = parts[parts.length - 1];
	const n = Number.parseInt(last, 10);
	return Number.isFinite(n) ? n : null;
}

function parseErrorResponse(body) {
	const fields = {};
	let offset = 0;
	while (offset < body.length) {
		const type = String.fromCharCode(body[offset]);
		if (type === '\0') break;
		const read = cstring(body, offset + 1);
		fields[type] = read.value;
		offset = read.next;
	}
	return new PgError(fields);
}
