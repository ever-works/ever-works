import { MachineProviderError } from '@ever-works/plugin';

/**
 * A small, dependency-free client for the DigitalOcean v2 REST API — the few
 * endpoints a machine provider needs (account, regions, sizes, SSH keys,
 * droplets, droplet actions, balance).
 *
 * Security posture:
 *  - the base URL is FIXED (`https://api.digitalocean.com`); nothing a user or
 *    a setting supplies can point it elsewhere (no SSRF through the plugin).
 *    Only the constructor's test seam may change it;
 *  - the token travels only in the `Authorization` header; it is never part of
 *    an error message, a log line or a thrown value;
 *  - every call times out after 15 s; a 429 is retried (twice) after the
 *    server's `Retry-After`, capped at 10 s;
 *  - errors become a typed `MachineProviderError` whose `hint` is the
 *    provider's own first line (`droplet limit reached for this account`),
 *    never the response body as a whole.
 */

export const DIGITALOCEAN_API_BASE = 'https://api.digitalocean.com';

const TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 10_000;

export interface DigitalOceanRequest {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	body?: unknown;
	/** Status codes that are an answer, not an error (e.g. 404 on a destroy). */
	accept?: readonly number[];
}

export interface DigitalOceanResponse<T> {
	status: number;
	data: T | null;
}

export class DigitalOceanApi {
	constructor(
		private readonly token: string,
		private readonly fetchImpl: typeof fetch = fetch,
		private readonly baseUrl: string = DIGITALOCEAN_API_BASE,
		private readonly sleep: (ms: number) => Promise<void> = (ms) =>
			new Promise((resolve) => setTimeout(resolve, ms))
	) {
		if (typeof token !== 'string' || token.trim().length === 0) {
			throw new MachineProviderError(
				'unauthorized',
				'no DigitalOcean API token is saved; add one in the plugin settings'
			);
		}
	}

	async request<T>(req: DigitalOceanRequest): Promise<DigitalOceanResponse<T>> {
		let attempt = 0;
		for (;;) {
			const response = await this.once(req);
			if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
				attempt += 1;
				await this.sleep(retryAfterMs(response.headers.get('retry-after')));
				continue;
			}
			const text = await response.text().catch(() => '');
			const parsed = parseJson(text);
			if (response.ok || req.accept?.includes(response.status)) {
				return { status: response.status, data: (parsed as T | null) ?? null };
			}
			throw toProviderError(response.status, parsed);
		}
	}

	private async once(req: DigitalOceanRequest): Promise<Response> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		try {
			return await this.fetchImpl(`${this.baseUrl}${req.path}`, {
				method: req.method,
				headers: {
					Authorization: `Bearer ${this.token.trim()}`,
					Accept: 'application/json',
					...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {})
				},
				body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
				signal: controller.signal
			});
		} catch (error) {
			const aborted = error instanceof Error && error.name === 'AbortError';
			throw new MachineProviderError(
				'unavailable',
				aborted ? 'DigitalOcean did not answer within 15 seconds' : 'DigitalOcean could not be reached'
			);
		} finally {
			clearTimeout(timer);
		}
	}
}

function parseJson(text: string): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** `Retry-After` in seconds (or an HTTP date) → milliseconds, at least 1 s, at most 10 s. */
export function retryAfterMs(header: string | null): number {
	if (!header) return 1_000;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_WAIT_MS, Math.max(1_000, seconds * 1_000));
	const at = Date.parse(header);
	if (Number.isFinite(at)) return Math.min(MAX_RETRY_WAIT_MS, Math.max(1_000, at - Date.now()));
	return 1_000;
}

/** The provider's own first line, bounded; never the whole body. */
function messageOf(body: unknown): string | null {
	if (body && typeof body === 'object') {
		const message = (body as { message?: unknown }).message;
		if (typeof message === 'string' && message.trim()) {
			return message.trim().split(/\r?\n/)[0].slice(0, 200);
		}
	}
	return null;
}

export function toProviderError(status: number, body: unknown): MachineProviderError {
	const message = messageOf(body);
	if (status === 401) {
		return new MachineProviderError(
			'unauthorized',
			'the DigitalOcean API token was refused; save a new one',
			status
		);
	}
	if (status === 403) {
		return new MachineProviderError(
			'forbidden',
			message ?? 'the DigitalOcean API token may not do this (it needs read and write scope)',
			status
		);
	}
	if (status === 404) return new MachineProviderError('not_found', message ?? 'not found at DigitalOcean', status);
	if (status === 422) {
		const lower = (message ?? '').toLowerCase();
		const quota = lower.includes('limit') || lower.includes('quota');
		return new MachineProviderError(
			quota ? 'quota' : 'invalid',
			message ?? 'DigitalOcean refused the request',
			status
		);
	}
	if (status === 429)
		return new MachineProviderError(
			'rate_limited',
			'DigitalOcean is rate-limiting this account; try again shortly',
			status
		);
	return new MachineProviderError('unavailable', message ?? `DigitalOcean answered ${status}`, status);
}
