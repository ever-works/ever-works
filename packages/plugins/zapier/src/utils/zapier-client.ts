import {
	createZapierSdk,
	ZapierError,
	ZapierAppNotFoundError,
	ZapierNotFoundError,
	ZapierAuthenticationError,
	ZapierRateLimitError,
	ZapierTimeoutError,
	ZapierValidationError,
	ZapierActionError
} from '@zapier/zapier-sdk';
import type { ZapierSdk, ActionItem } from '@zapier/zapier-sdk';
import type { ZapierActionRef } from '../types.js';

export interface ZapierExecutionResult {
	/** Raw data returned by the Zapier action — either an array of records or a wrapped object, depending on the Zap. */
	data: unknown;
	zapierDuration: number;
	nextCursor?: string;
}

export interface ZapierClientCredentials {
	clientId: string;
	clientSecret: string;
}

interface ZapierClientOptions {
	/** Direct bearer token — suitable for local dev (npx zapier-sdk login). */
	accessToken?: string;
	/** Long-lived client credentials — suitable for production / CI. */
	credentials?: ZapierClientCredentials;
	baseUrl?: string;
	logger: { log(...args: unknown[]): void; warn(...args: unknown[]): void };
}

/**
 * Thin wrapper around the Zapier SDK that adds abort-signal support
 * and user-friendly error messages.
 */
export class ZapierClient {
	private readonly sdk: ZapierSdk;
	private readonly logger: ZapierClientOptions['logger'];

	constructor(options: ZapierClientOptions) {
		if (!options.credentials && !options.accessToken) {
			throw new Error(
				'Zapier authentication is not configured. Provide either clientId+clientSecret or accessToken.'
			);
		}

		const sdkOptions: Parameters<typeof createZapierSdk>[0] = {};
		if (options.credentials) {
			sdkOptions.credentials = {
				clientId: options.credentials.clientId,
				clientSecret: options.credentials.clientSecret
			};
		} else if (options.accessToken) {
			sdkOptions.token = options.accessToken;
		}
		if (options.baseUrl) sdkOptions.baseUrl = options.baseUrl;

		this.sdk = createZapierSdk(sdkOptions);
		this.logger = options.logger;
	}

	/** Confirms the action exists and the credentials have access. */
	async validateAction(ref: ZapierActionRef): Promise<ActionItem> {
		try {
			const response = await this.sdk.getAction({
				appKey: ref.appKey,
				actionType: ref.actionType,
				actionKey: ref.actionKey
			});
			return response.data;
		} catch (error) {
			throw this.wrapError(error, `validate action ${ref.appKey}.${ref.actionType}.${ref.actionKey}`);
		}
	}

	/**
	 * Executes the action. The Zapier SDK's `runAction` resolves with an array of
	 * output records when the action completes, or throws on failure. We race it
	 * against the abort signal so cancellation during long-running actions still resolves.
	 */
	async executeAction(
		ref: ZapierActionRef,
		inputs: Record<string, unknown>,
		signal?: AbortSignal
	): Promise<ZapierExecutionResult> {
		if (signal?.aborted) throw new Error('Pipeline execution was cancelled');

		const startTime = Date.now();
		this.logger.log(`Running Zapier action "${ref.appKey}.${ref.actionType}.${ref.actionKey}"`);

		const runPromise = this.sdk.runAction({
			appKey: ref.appKey,
			actionType: ref.actionType,
			actionKey: ref.actionKey,
			authenticationId: ref.authenticationId,
			inputs
		});

		let result: { data: unknown[]; nextCursor?: string };
		try {
			result = await (signal ? raceWithAbort(runPromise, signal) : runPromise);
		} catch (error) {
			throw this.wrapError(error, `run action ${ref.appKey}.${ref.actionType}.${ref.actionKey}`);
		}

		return {
			data: result.data,
			nextCursor: result.nextCursor,
			zapierDuration: Date.now() - startTime
		};
	}

	private wrapError(error: unknown, context: string): Error {
		if (error instanceof ZapierAppNotFoundError) {
			const appKey = error.appKey ?? 'unknown';
			return new Error(
				`Zapier app "${appKey}" was not found. Check the app key and that your credentials have access to it.`
			);
		}
		if (error instanceof ZapierAuthenticationError) {
			return new Error(
				'Zapier credentials are invalid or expired. For local dev re-run `npx zapier-sdk login`; for production verify ZAPIER_CREDENTIALS_CLIENT_ID / ZAPIER_CREDENTIALS_CLIENT_SECRET.'
			);
		}
		if (error instanceof ZapierRateLimitError) {
			return new Error('Zapier rate limit exceeded. Please wait and try again.');
		}
		if (error instanceof ZapierTimeoutError) {
			return new Error('Zapier action timed out. Try increasing the timeout setting.');
		}
		if (error instanceof ZapierValidationError) {
			return new Error('Zapier rejected the action inputs. Check that required input fields are present and valid.');
		}
		if (error instanceof ZapierActionError) {
			return new Error(`Zapier action failed: ${error.message}`);
		}
		if (error instanceof ZapierNotFoundError) {
			return new Error('Zapier action or authentication not found. Verify the app key, action key, and authentication ID.');
		}
		if (error instanceof ZapierError) {
			return new Error(`Zapier error during ${context}: ${error.message}`);
		}
		if (error instanceof Error) {
			return error;
		}
		return new Error(`Unexpected error during ${context}: ${String(error)}`);
	}
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener('abort', onAbort);
			reject(new Error('Pipeline execution was cancelled'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			}
		);
	});
}
