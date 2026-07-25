/** Health polling for the locally supervised platform services. */

export const API_HEALTH_URL = 'http://localhost:3100/api/health';
export const WEB_APP_URL = 'http://localhost:3000';

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number }>;

export async function checkHealthOnce(url: string, fetchFn: FetchLike): Promise<boolean> {
	try {
		const response = await fetchFn(url);
		return response.ok;
	} catch {
		return false;
	}
}

export interface WaitForHealthyOptions {
	fetchFn: FetchLike;
	intervalMs?: number;
	timeoutMs?: number;
	/** Injectable for tests; defaults to a real timer sleep. */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/** Poll `url` until it reports healthy or `timeoutMs` elapses. Resolves with the final health state. */
export async function waitForHealthy(url: string, options: WaitForHealthyOptions): Promise<boolean> {
	const intervalMs = options.intervalMs ?? 2_000;
	const timeoutMs = options.timeoutMs ?? 120_000;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const now = options.now ?? (() => Date.now());

	const startedAt = now();
	for (;;) {
		if (await checkHealthOnce(url, options.fetchFn)) {
			return true;
		}
		if (now() - startedAt >= timeoutMs) {
			return false;
		}
		await sleep(intervalMs);
	}
}
