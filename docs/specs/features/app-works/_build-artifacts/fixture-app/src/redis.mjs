/**
 * A minimal Redis client (RESP2) over `node:net` — Node built-ins only.
 *
 * Used by `GET /state` when the `all-dependencies` profile gives the fixture a Redis dependency
 * (blueprint README, profiles/all-dependencies.works.yml). It speaks just enough RESP to prove the
 * dependency is reachable and usable: `PING`, `SET`, `GET`, `DEL`, `AUTH` and `SELECT`.
 */

import net from 'node:net';

const CRLF = '\r\n';

/** @param {string} url `redis://[:password@]host:port[/db]` */
export function parseRedisUrl(url) {
	if (!url) return null;
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error('REDIS_URL is not a URL');
	}
	if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
		throw new Error(`REDIS_URL must start with redis:// (got ${parsed.protocol}//)`);
	}
	return {
		host: parsed.hostname || '127.0.0.1',
		port: Number(parsed.port || 6379),
		password: decodeURIComponent(parsed.password || ''),
		username: decodeURIComponent(parsed.username || ''),
		database: Number((parsed.pathname || '/0').replace(/^\//, '') || 0),
		tls: parsed.protocol === 'rediss:'
	};
}

export class RedisClient {
	#socket = null;
	#buffer = Buffer.alloc(0);
	#queue = [];
	#failure = null;

	/** @param {{url?: string, host?: string, port?: number, password?: string, database?: number, timeoutMs?: number}} config */
	constructor(config = {}) {
		this.config = { ...(parseRedisUrl(config.url) ?? {}), ...config };
		this.timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 2_000;
	}

	async connect() {
		if (this.#socket) return this;
		const { host, port } = this.config;
		if (!host) throw new Error('redis: no host configured');
		const socket = net.connect({ host, port: port || 6379 });
		this.#socket = socket;
		socket.setNoDelay(true);
		socket.on('data', (chunk) => {
			this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
			this.#pump();
		});
		socket.on('error', (error) => this.#fail(error));
		socket.on('close', () => this.#fail(new Error('redis: connection closed')));
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('redis: connect timed out')), this.timeoutMs);
			socket.once('connect', () => {
				clearTimeout(timer);
				resolve();
			});
			socket.once('error', (error) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		if (this.config.password) {
			await this.config.username
				? this.command('AUTH', this.config.username, this.config.password)
				: this.command('AUTH', this.config.password);
		}
		if (this.config.database) await this.command('SELECT', String(this.config.database));
		return this;
	}

	/** @param {string} name @param {...(string|number)} args */
	command(name, ...args) {
		if (!this.#socket) return Promise.reject(new Error('redis: not connected'));
		const payload = [name, ...args].map((part) => `$${Buffer.byteLength(String(part))}${CRLF}${part}${CRLF}`);
		this.#socket.write(`*${payload.length}${CRLF}${payload.join('')}`);
		return new Promise((resolve, reject) => {
			const entry = { resolve, reject };
			entry.timer = setTimeout(() => {
				const index = this.#queue.indexOf(entry);
				if (index >= 0) this.#queue.splice(index, 1);
				reject(new Error(`redis: ${String(name).toUpperCase()} timed out after ${this.timeoutMs} ms`));
			}, this.timeoutMs);
			this.#queue.push(entry);
			this.#pump();
		});
	}

	#fail(error) {
		if (!this.#failure) this.#failure = error instanceof Error ? error : new Error(String(error));
		while (this.#queue.length) {
			const entry = this.#queue.shift();
			clearTimeout(entry.timer);
			entry.reject(this.#failure);
		}
	}

	#pump() {
		for (;;) {
			const parsed = this.#decode(0);
			if (!parsed) return;
			this.#buffer = this.#buffer.subarray(parsed.next);
			const entry = this.#queue.shift();
			if (!entry) continue;
			clearTimeout(entry.timer);
			if (parsed.error) entry.reject(new Error(`redis: ${parsed.error}`));
			else entry.resolve(parsed.value);
		}
	}

	#decode(offset) {
		if (this.#buffer.length <= offset) return null;
		const type = String.fromCharCode(this.#buffer[offset]);
		const lineEnd = this.#buffer.indexOf(CRLF, offset);
		if (lineEnd === -1) return null;
		const line = this.#buffer.subarray(offset + 1, lineEnd).toString('utf8');
		const afterLine = lineEnd + 2;
		switch (type) {
			case '+':
				return { value: line, next: afterLine };
			case '-':
				return { error: line, next: afterLine };
			case ':':
				return { value: Number.parseInt(line, 10), next: afterLine };
			case '$': {
				const length = Number.parseInt(line, 10);
				if (length === -1) return { value: null, next: afterLine };
				if (this.#buffer.length < afterLine + length + 2) return null;
				return {
					value: this.#buffer.subarray(afterLine, afterLine + length).toString('utf8'),
					next: afterLine + length + 2
				};
			}
			case '*': {
				const count = Number.parseInt(line, 10);
				if (count === -1) return { value: null, next: afterLine };
				const items = [];
				let cursor = afterLine;
				for (let i = 0; i < count; i += 1) {
					const item = this.#decode(cursor);
					if (!item) return null;
					if (item.error) return { error: item.error, next: item.next };
					items.push(item.value);
					cursor = item.next;
				}
				return { value: items, next: cursor };
			}
			default:
				return { error: `unexpected RESP type ${JSON.stringify(type)}`, next: afterLine };
		}
	}

	async end() {
		const socket = this.#socket;
		this.#socket = null;
		if (!socket || socket.destroyed) return;
		await new Promise((resolve) => {
			socket.end(() => resolve());
			setTimeout(() => {
				socket.destroy();
				resolve();
			}, 200).unref?.();
		});
	}
}

/**
 * Prove the dependency end to end: connect, `PING`, write a key, read it back, delete it.
 * @returns {Promise<{ok: boolean, detail: string, ms: number, value?: unknown}>}
 */
export async function redisRoundTrip(env = process.env, key = `app-fixture-hello:${process.pid}`) {
	const started = Date.now();
	const url = env.REDIS_URL || env.REDIS_TLS_URL;
	if (!url) return { ok: false, detail: 'REDIS_URL is not set', ms: 0 };
	const client = new RedisClient({ url, timeoutMs: numberOr(env.FIXTURE_REDIS_TIMEOUT_MS, 2_000) });
	try {
		await client.connect();
		const pong = await client.command('PING');
		if (String(pong).toUpperCase() !== 'PONG') return { ok: false, detail: `unexpected PING reply ${pong}`, ms: Date.now() - started };
		const token = `${Date.now()}`;
		await client.command('SET', key, token, 'EX', '60');
		const read = await client.command('GET', key);
		await client.command('DEL', key);
		const ok = String(read) === token;
		return { ok, detail: ok ? 'PING, SET, GET and DEL all answered' : 'the value read back did not match', ms: Date.now() - started, value: pong };
	} catch (error) {
		return { ok: false, detail: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
	} finally {
		await client.end().catch(() => undefined);
	}
}

function numberOr(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
