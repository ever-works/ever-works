import * as http from 'node:http';
import * as https from 'node:https';
import {
	FLEET_PORT_PROBE_BODY_CAP,
	FLEET_PORT_PROBE_CONCURRENCY,
	FLEET_PORT_PROBE_TIMEOUT_MS,
	FLEET_PORT_TITLE_MAX,
	isFleetPortNumber,
	redactSecrets
} from '@ever-works/contracts';

/**
 * Servers and ports (FL-10, plan §3 "HTTP probe") — does a port answer HTTP
 * when the machine asks ITSELF?
 *
 * `GET /` to `127.0.0.1:<port>` — the loopback, always; there is no
 * parameter for another host, so a probe can never be aimed elsewhere —
 * with `Accept: text/html`, a {@link FLEET_PORT_PROBE_TIMEOUT_MS} budget and
 * at most {@link FLEET_PORT_PROBE_BODY_CAP} bytes read. A port whose plain
 * HTTP answer is a protocol error (a TLS server) is asked again over HTTPS
 * with certificate checks off: a self-signed dev server is still a web
 * server, with an `https` badge (spec U6). The page `<title>` is taken from
 * the bytes read, entity-decoded, collapsed, cut to
 * {@link FLEET_PORT_TITLE_MAX} characters and passed through the shared
 * secret scanner before it leaves the machine.
 *
 * Nothing about the page but its status, its `Server` header and its title
 * is kept; the body is dropped as soon as it has been read.
 */

export type HttpProbeResult =
	| {
			kind: 'http';
			scheme: 'http' | 'https';
			status: number;
			title: string | null;
			/** The `Server` header, for the Windows HTTP-stack check (U7). Not reported upward. */
			server: string | null;
			probedAt: string;
	  }
	/** Accepted the connection, said nothing HTTP within the budget (spec U6). */
	| { kind: 'silent' }
	/** Refused or unreachable on the loopback (bound to another interface only, or gone). */
	| { kind: 'refused' };

type RequestFn = (
	options: https.RequestOptions,
	callback: (response: http.IncomingMessage) => void
) => http.ClientRequest;

export interface HttpProbeOptions {
	timeoutMs?: number;
	bodyCap?: number;
	now?: () => Date;
	/** Test seams: the plain and TLS request functions. */
	httpRequest?: RequestFn;
	httpsRequest?: RequestFn;
}

const ENTITIES: Readonly<Record<string, string>> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	mdash: '—',
	ndash: '–',
	middot: '·'
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (match, entity: string) => {
		if (entity[0] === '#') {
			const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
			return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[entity.toLowerCase()] ?? match;
	});
}

/**
 * The page title from the first bytes of a page, or null. Linear: the open
 * tag is found with `indexOf`, never a backtracking pattern over the body.
 */
export function extractTitle(body: string): string | null {
	const lower = body.toLowerCase();
	let open = lower.indexOf('<title');
	while (open >= 0) {
		const next = lower[open + 6];
		// `<title>` or `<title attr…>`, not `<titlebar>`.
		if (next === '>' || next === ' ' || next === '\t' || next === '\n' || next === '\r') break;
		open = lower.indexOf('<title', open + 6);
	}
	if (open < 0) return null;
	const start = lower.indexOf('>', open);
	if (start < 0) return null;
	const end = lower.indexOf('</title', start + 1);
	if (end < 0) return null;
	const raw = decodeEntities(body.slice(start + 1, end))
		// eslint-disable-next-line no-control-regex
		.replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
		.trim();
	if (raw.length === 0) return null;
	const cut = raw.length > FLEET_PORT_TITLE_MAX ? `${raw.slice(0, FLEET_PORT_TITLE_MAX - 1)}…` : raw;
	return redactSecrets(cut).cleaned;
}

function headerText(value: string | string[] | undefined): string | null {
	if (Array.isArray(value)) return value[0] ?? null;
	return typeof value === 'string' ? value.slice(0, 200) : null;
}

type Attempt =
	| { kind: 'http'; status: number; server: string | null; body: string }
	| { kind: 'timeout' }
	| { kind: 'protocol' }
	| { kind: 'refused' };

function attempt(request: RequestFn, port: number, tls: boolean, timeoutMs: number, bodyCap: number): Promise<Attempt> {
	return new Promise((resolve) => {
		let settled = false;
		const chunks: Buffer[] = [];
		let size = 0;
		const finish = (outcome: Attempt): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				req.destroy();
			} catch {
				// already gone
			}
			resolve(outcome);
		};
		const options: https.RequestOptions = {
			host: '127.0.0.1',
			port,
			method: 'GET',
			path: '/',
			headers: {
				Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
				'User-Agent': 'ever-works-node (ports)',
				Connection: 'close'
			},
			agent: false,
			// A dev server's self-signed certificate is still a web server (U6); nothing is sent but `GET /`.
			...(tls ? { rejectUnauthorized: false } : {})
		};
		let status = 0;
		let server: string | null = null;
		const req = request(options, (response) => {
			status = response.statusCode ?? 0;
			server = headerText(response.headers.server);
			response.on('data', (chunk: Buffer) => {
				if (size >= bodyCap) return;
				const room = bodyCap - size;
				const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
				chunks.push(piece);
				size += piece.length;
				if (size >= bodyCap) finish({ kind: 'http', status, server, body: Buffer.concat(chunks).toString('utf8') });
			});
			response.on('end', () => finish({ kind: 'http', status, server, body: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', () => finish({ kind: 'http', status, server, body: Buffer.concat(chunks).toString('utf8') }));
		});
		const timer = setTimeout(() => {
			// Headers arrived but the body is slow: the answer is still HTTP.
			if (status > 0) finish({ kind: 'http', status, server, body: Buffer.concat(chunks).toString('utf8') });
			else finish({ kind: 'timeout' });
		}, timeoutMs);
		req.on('error', (error: NodeJS.ErrnoException) => {
			if (status > 0) {
				finish({ kind: 'http', status, server, body: Buffer.concat(chunks).toString('utf8') });
				return;
			}
			const code = error.code ?? '';
			if (code === 'ECONNREFUSED' || code === 'EADDRNOTAVAIL' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
				finish({ kind: 'refused' });
			} else {
				// A parse error, a reset, a TLS alert: something answered, not in this protocol.
				finish({ kind: 'protocol' });
			}
		});
		req.end();
	});
}

/** Probe one port on the loopback. Never throws. */
export async function probeHttp(port: number, options: HttpProbeOptions = {}): Promise<HttpProbeResult> {
	if (!isFleetPortNumber(port)) return { kind: 'refused' };
	const timeoutMs = options.timeoutMs ?? FLEET_PORT_PROBE_TIMEOUT_MS;
	const bodyCap = options.bodyCap ?? FLEET_PORT_PROBE_BODY_CAP;
	const now = options.now ?? (() => new Date());
	const started = Date.now();
	const plain = await attempt(options.httpRequest ?? http.request, port, false, timeoutMs, bodyCap);
	if (plain.kind === 'http') {
		return {
			kind: 'http',
			scheme: 'http',
			status: plain.status,
			title: extractTitle(plain.body),
			server: plain.server,
			probedAt: now().toISOString()
		};
	}
	if (plain.kind === 'refused') return { kind: 'refused' };
	if (plain.kind === 'timeout') return { kind: 'silent' };
	// A protocol error over plain HTTP: try TLS within what is left of the budget.
	const left = Math.max(250, timeoutMs - (Date.now() - started));
	const tls = await attempt(options.httpsRequest ?? https.request, port, true, left, bodyCap);
	if (tls.kind === 'http') {
		return {
			kind: 'http',
			scheme: 'https',
			status: tls.status,
			title: extractTitle(tls.body),
			server: tls.server,
			probedAt: now().toISOString()
		};
	}
	return tls.kind === 'refused' ? { kind: 'refused' } : { kind: 'silent' };
}

/** Run `task` over `items`, at most `limit` at once, preserving order. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const width = Math.max(1, Math.min(limit, items.length));
	const workers = Array.from({ length: width }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await task(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

/** Probe many ports, {@link FLEET_PORT_PROBE_CONCURRENCY} at once. */
export function probeMany(ports: readonly number[], options: HttpProbeOptions = {}): Promise<HttpProbeResult[]> {
	return mapWithConcurrency(ports, FLEET_PORT_PROBE_CONCURRENCY, (port) => probeHttp(port, options));
}
