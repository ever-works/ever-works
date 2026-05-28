import { Composio } from '@composio/core';
import type { ComposioToolRef, ComposioConnectedAccount, ComposioToolkitEntry } from '../types.js';

export interface ComposioExecutionResult {
	/**
	 * Raw data returned by the Composio tool. The official `@composio/core`
	 * SDK already unwraps the v3 response envelope (`{ successful, data, error,
	 * log_id }`) — successful executions resolve to the tool's `data` payload,
	 * failures throw. We surface that `data` here verbatim.
	 */
	data: unknown;
	composioDuration: number;
}

interface ComposioClientOptions {
	apiKey: string;
	baseUrl?: string;
	logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
	/**
	 * Test seam — pass a stub `Composio`-shaped object to bypass SDK
	 * construction. Unit tests inject their mocked SDK here instead of
	 * `vi.mock`-ing the whole `@composio/core` module, which would also
	 * trip the version-validation modifier the SDK installs at import time.
	 */
	sdkOverride?: ComposioSdkLike;
}

interface ExecuteToolOptions {
	signal?: AbortSignal;
}

/**
 * Subset of the official `@composio/core` SDK surface we actually use.
 * Pinned here so a stray major-version bump doesn't silently re-route us
 * onto methods we haven't audited. Keep this in sync with the SDK reference
 * at https://docs.composio.dev/sdk-reference/type-script/core-classes/composio.
 */
export interface ComposioSdkLike {
	toolkits: {
		get(query?: { limit?: number }): Promise<{ items: ComposioToolkitEntry[] }>;
	};
	connectedAccounts: {
		list(query?: {
			userIds?: string[];
			toolkitSlugs?: string[];
			limit?: number;
		}): Promise<{ items: ComposioConnectedAccount[] }>;
	};
	tools: {
		execute(
			slug: string,
			body: { userId: string; arguments?: Record<string, unknown> }
		): Promise<{
			successful?: boolean;
			data?: unknown;
			error?: string;
			/**
			 * The SDK transforms the v3 wire response from snake_case to camelCase
			 * before resolving the promise — `log_id` → `logId`. Verified against
			 * `@composio/core@0.10.0` (`dist/index.mjs`: `logId: response.log_id`).
			 * We also tolerate `log_id` on the envelope as a defensive fallback
			 * in case a future SDK version skips the transform.
			 */
			logId?: string;
			log_id?: string;
		}>;
	};
}

/**
 * Thin wrapper around the official `@composio/core` SDK.
 *
 * Per Workspace AGENTS.md NN #22 ("Always use the official SDK for
 * third-party APIs — never hand-roll a REST client"), this replaces the
 * v1 handwritten REST client that shipped in PR #1079. The SDK gets
 * pagination, retries, response-envelope unwrapping, query-param list
 * serialization (e.g. `user_ids` as repeated params), version validation,
 * and breaking-change handling right — all of which we'd otherwise own.
 *
 * What's preserved from v1:
 *  - The public surface (`validateConnection`, `listToolkits`,
 *    `listConnectedAccounts`, `executeTool`) so `composio.plugin.ts`
 *    doesn't change.
 *  - Abort-signal support layered on top of the SDK via `Promise.race`.
 *    Note: the SDK call itself can't be cancelled mid-flight; what we
 *    cancel is our *await* on it. The HTTP request may still complete on
 *    the wire — that's fine for the plugin's pipeline-timeout use case.
 *  - Friendly error messages around 401/403, missing connections, etc.
 */
export class ComposioClient {
	private readonly sdk: ComposioSdkLike;
	private readonly logger: ComposioClientOptions['logger'];

	constructor(options: ComposioClientOptions) {
		if (!options.apiKey || options.apiKey.trim() === '') {
			throw new Error('Composio API key is required.');
		}
		this.logger = options.logger;
		this.sdk = options.sdkOverride ?? this.buildSdk(options.apiKey.trim(), options.baseUrl);
	}

	private buildSdk(apiKey: string, baseUrl: string | undefined): ComposioSdkLike {
		const sdkConfig: { apiKey: string; baseURL?: string } = { apiKey };
		if (baseUrl) {
			// Composio's SDK config uses `baseURL` (capital L) — the underlying
			// `@composio/client` follows axios-style naming. Strip trailing
			// slashes so concatenation in the SDK works the same regardless
			// of how the user typed it in settings.
			sdkConfig.baseURL = baseUrl.replace(/\/+$/, '');
		}
		// The SDK constructor returns a richer instance than ComposioSdkLike
		// declares; the structural cast pins us to the subset we actually use.
		return new Composio(sdkConfig) as unknown as ComposioSdkLike;
	}

	/**
	 * Validates that:
	 *  1. The API key is accepted (the SDK throws on 401/403).
	 *  2. The toolkit exists.
	 *  3. The user has at least one ACTIVE connected account for the toolkit.
	 *
	 * Throws a user-friendly error explaining which check failed.
	 */
	async validateConnection(ref: ComposioToolRef): Promise<ComposioConnectedAccount> {
		const accounts = await this.listConnectedAccounts(ref.userId, ref.toolkit);
		const active = accounts.find((a) => normalizeStatus(a.status) === 'ACTIVE');
		if (!active) {
			throw new Error(
				`No active Composio connected account found for user "${ref.userId}" on toolkit "${ref.toolkit}". ` +
					`Connect ${ref.toolkit} in the Composio dashboard (or via the plugin's connect flow) and retry.`
			);
		}
		return active;
	}

	/** Lists toolkits the API key has access to. Used by `isAvailable` and the settings UI. */
	async listToolkits(limit = 50): Promise<ComposioToolkitEntry[]> {
		try {
			const response = await this.sdk.toolkits.get({ limit: Math.max(1, Math.min(limit, 200)) });
			return response.items ?? [];
		} catch (error) {
			throw this.wrapError(error, 'list toolkits');
		}
	}

	/**
	 * Lists the user's connected accounts, optionally filtered by toolkit.
	 * Returns an empty array if the API key has no access to that user or
	 * if the user has not connected any account yet.
	 */
	async listConnectedAccounts(userId: string, toolkit?: string): Promise<ComposioConnectedAccount[]> {
		try {
			const query: { userIds: string[]; toolkitSlugs?: string[] } = { userIds: [userId] };
			if (toolkit) query.toolkitSlugs = [toolkit.toUpperCase()];
			const response = await this.sdk.connectedAccounts.list(query);
			return response.items ?? [];
		} catch (error) {
			throw this.wrapError(error, 'list connected accounts');
		}
	}

	/**
	 * Executes a tool against the resolved user. The SDK unwraps the v3
	 * envelope (`{ successful, data, error }`) — on success we return its
	 * `data`; on failure (`successful === false`) we throw with the upstream
	 * error text including the log id when present.
	 *
	 * Cancellation: the SDK does not accept an AbortSignal, so we race our
	 * await against the signal. When the signal fires, this method rejects
	 * with "Pipeline execution was cancelled"; the SDK's HTTP request may
	 * still complete on the wire but its result is discarded.
	 */
	async executeTool(
		ref: ComposioToolRef,
		args: Record<string, unknown>,
		options?: ExecuteToolOptions
	): Promise<ComposioExecutionResult> {
		const signal = options?.signal;
		if (signal?.aborted) throw new Error('Pipeline execution was cancelled');

		const startTime = Date.now();
		this.logger.log(`Running Composio tool "${ref.toolSlug}" for user "${ref.userId}"`);

		const execPromise = this.sdk.tools
			.execute(ref.toolSlug, {
				userId: ref.userId,
				arguments: args
			})
			.catch((error: unknown) => {
				throw this.wrapError(error, `execute tool ${ref.toolSlug}`);
			});

		const envelope = signal ? await raceWithAbort(execPromise, signal) : await execPromise;

		if (envelope.successful === false) {
			// `logId` is the SDK-camelCased form; fall back to raw `log_id` in case
			// a future SDK version stops transforming. Operators rely on this id
			// to look up the upstream-app failure in the Composio dashboard.
			const logId = envelope.logId ?? envelope.log_id;
			throw new Error(
				`Composio tool "${ref.toolSlug}" execution failed: ${envelope.error ?? 'unknown error'}` +
					(logId ? ` (log_id=${logId})` : '')
			);
		}

		return {
			data: envelope.data ?? envelope,
			composioDuration: Date.now() - startTime
		};
	}

	private wrapError(error: unknown, context: string): Error {
		if (error instanceof Error) {
			const message = error.message || String(error);
			const status = readNumberProp(error, 'status') ?? readNumberProp(error, 'statusCode');

			if (status === 401 || status === 403) {
				return new Error(
					`Composio rejected the API key (HTTP ${status}) during ${context}. Verify COMPOSIO_API_KEY in plugin settings.`
				);
			}
			if (status === 404) {
				return new Error(
					`Composio returned 404 during ${context}. Likely causes: the tool slug or toolkit does not exist, ` +
						`or the user has no connected account.`
				);
			}
			if (status === 408 || status === 504) {
				return new Error(`Composio request timed out during ${context} (HTTP ${status}).`);
			}
			if (status === 429) {
				return new Error('Composio rate limit exceeded (HTTP 429). Wait and retry.');
			}
			if (status !== undefined && status >= 500) {
				return new Error(
					`Composio is returning HTTP ${status} during ${context}. Check https://status.composio.dev. ` +
						`(${message})`
				);
			}
			// SDK error subclass we don't have a custom-rewording rule for — keep the original message.
			return new Error(`Composio error during ${context}: ${message}`);
		}
		return new Error(`Unexpected error during ${context}: ${String(error)}`);
	}
}

function normalizeStatus(status: string | undefined): string {
	return (status || '').trim().toUpperCase();
}

function readNumberProp(target: object, prop: string): number | undefined {
	const value = (target as Record<string, unknown>)[prop];
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Races a promise against an `AbortSignal`. When the signal fires we reject
 * with the cancellation marker; when the promise settles first we forward
 * its outcome and unhook the abort listener so we don't leak references.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => {
			signal.removeEventListener('abort', onAbort);
			reject(new Error('Pipeline execution was cancelled'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error as Error);
			}
		);
	});
}
