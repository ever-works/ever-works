import { readFileSync } from 'node:fs';

import type { IdentityProviderCheck, PluginContext } from '@ever-works/plugin';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	OIDC_DISCOVERY_CACHE_SECONDS,
	OIDC_IDENTITY_SIGNING_ALGS,
	OIDC_OUTBOUND_RETRY_DELAY_MS,
	OIDC_OUTBOUND_TIMEOUT_MS,
	OidcDiscoveryReader,
	type OidcFetchImpl,
	type OidcHttpResponse
} from '../discovery.js';
import { FR3_CHECK_IDS, FR3_REQUIRED_CHECK_IDS, OidcIdentityPlugin } from '../oidc-identity.plugin.js';

/**
 * APW-12 T6 — **Test connection** (FR-3) and the public configuration (FR-2),
 * against the two properties T6 names for this file:
 *
 *   1. **each FR-3 check inside 5 s** — ACC-12-03;
 *   2. **the secret absent from the output** — ACC-12-03, asserted against the
 *      *serialised* result of both methods, the captured log lines, and an error
 *      path whose injected transport error literally contains the secret.
 *
 * ## The clock, and why nothing here waits
 *
 * The plugin's constructor takes two optional seams (`OidcIdentityPluginOptions`:
 * `fetchImpl`, `now`). They were added by T6, additively and with production
 * defaults (`globalThis.fetch`, `Date.now`), because none of these numbers can be
 * proven by a spec that really waits: a 5,000 ms timeout, a 1,000 ms retry delay
 * and a 3,600-second discovery cache are all driven here by **vitest's fake
 * timers** (`vi.setSystemTime` for the clock, `vi.advanceTimersByTimeAsync` for
 * the abort timer, which is a `setTimeout` in `discovery.ts` for exactly this
 * reason — `AbortSignal.timeout` would ignore the fake clock). One case injects the
 * clock explicitly to prove the seam is honoured rather than `Date.now` being read
 * behind it.
 *
 * ## The `./testing` subpath rule (plan §10.4)
 *
 * Every fake in this file is local to this file. Nothing test-only is exported
 * from `src/index.ts` and no second entry point is created: plan §10.4 publishes
 * T8's fake provider through a `./testing` subpath so Playwright and the API
 * integration spec can share it, and a diagnostic fixture for this package has no
 * such consumer — so it stays here, which is stricter than the rule rather than an
 * exception to it.
 *
 * ## Why the assertions never print the secret
 *
 * Following T5's `settings.schema.spec.ts`: every check that touches the secret
 * compares a boolean first (`const leaked = …; expect(leaked).toBe(false)`),
 * because a failing `expect(value)` would paste the secret into this spec's own
 * failure message — the property ACC-12-03 protects, applied to the test as well.
 */

const SECRET = 'ever-id-client-secret-0123456789abcdef-do-not-print';
const ISSUER = 'https://auth.ever.co';
const BASE_TIME = Date.parse('2026-09-17T09:00:00.000Z');

/**
 * FR-3's and FR-15's numbers, written as literals rather than read from the module.
 *
 * A behavioural test that advances the clock by the very constant it is meant to pin
 * follows a perturbation of that constant instead of catching it (measured: with
 * `OIDC_OUTBOUND_TIMEOUT_MS` mutated to 50,000, only the transcribed-numbers check at
 * the end of this file reddened). The exported constants are pinned there; the cases
 * here assert the behaviour against the spec's own words.
 */
const FR3_BOUND_MS = 5_000;
const FR15_RETRY_DELAY_MS = 1_000;

/** The discovery document a healthy ZITADEL-shaped provider publishes (plan §4.3). */
const healthyDocument = (): Record<string, unknown> => ({
	issuer: ISSUER,
	authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
	token_endpoint: `${ISSUER}/oauth/v2/token`,
	jwks_uri: `${ISSUER}/oauth/v2/keys`,
	userinfo_endpoint: `${ISSUER}/oidc/v1/userinfo`,
	end_session_endpoint: `${ISSUER}/oidc/v1/end_session`,
	device_authorization_endpoint: `${ISSUER}/oauth/v2/device_authorize`,
	code_challenge_methods_supported: ['S256'],
	id_token_signing_alg_values_supported: ['RS256'],
	backchannel_logout_supported: true,
	backchannel_logout_session_supported: true
});

/** The smallest configuration plan §4.2 accepts, secret included on purpose. */
const settings = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
	issuerUrl: ISSUER,
	clientId: 'ever-works-web',
	clientSecret: SECRET,
	...overrides
});

interface CapturedLogger {
	readonly lines: string[];
	readonly log: (message: string, ...rest: unknown[]) => void;
	readonly warn: (message: string, ...rest: unknown[]) => void;
	readonly error: (message: string, ...rest: unknown[]) => void;
	readonly debug: (message: string, ...rest: unknown[]) => void;
}

const captureLogger = (): CapturedLogger => {
	const lines: string[] = [];
	const record =
		(level: string) =>
		(message: string, ...rest: unknown[]) => {
			lines.push(`${level} ${message} ${rest.map((value) => JSON.stringify(value) ?? '').join(' ')}`);
		};
	return { lines, log: record('log'), warn: record('warn'), error: record('error'), debug: record('debug') };
};

const contextFor = (values: Record<string, unknown>, logger = captureLogger()): PluginContext =>
	({
		pluginId: 'oidc-identity',
		logger,
		cache: {},
		http: {},
		env: {},
		envVars: {},
		services: {},
		getSettings: vi.fn().mockResolvedValue(values)
	}) as unknown as PluginContext;

/**
 * A provider whose discovery document is served from memory.
 *
 * `mode` is the whole vocabulary `discovery.ts` has to survive: a normal answer, an
 * error status, a body that is not JSON, a socket that never answers, a transport
 * error, and — the adversarial one — a transport error that carries the secret in
 * its own message. `requests` records when each attempt started, so FR-15's retry
 * delay is asserted rather than assumed.
 */
interface FakeProvider {
	readonly requests: number[];
	readonly fetch: OidcFetchImpl;
	mode: 'ok' | 'http500' | 'invalidJson' | 'hang' | 'ignoreSignal' | 'reject' | 'rejectWithSecret';
	document: Record<string, unknown>;
}

const fakeProvider = (mode: FakeProvider['mode'] = 'ok'): FakeProvider => {
	const provider: FakeProvider = {
		requests: [],
		mode,
		document: healthyDocument(),
		fetch: async (_url, init): Promise<OidcHttpResponse> => {
			provider.requests.push(Date.now());
			switch (provider.mode) {
				case 'http500':
					return { ok: false, status: 503, json: async () => ({}) };
				case 'invalidJson':
					return {
						ok: true,
						status: 200,
						json: async () => {
							throw new SyntaxError('Unexpected token <');
						}
					};
				case 'hang':
					// A real `fetch` rejects when its signal aborts; modelling that is
					// what makes the 5,000 ms bound observable at all.
					return new Promise<OidcHttpResponse>((_resolve, reject) => {
						init.signal.addEventListener('abort', () =>
							reject(new DOMException('The operation was aborted.', 'AbortError'))
						);
					});
				case 'ignoreSignal':
					// The adversarial case for FR-3's deadline: a socket that ignores the
					// abort entirely must still not hold the run past 5 seconds.
					return new Promise<OidcHttpResponse>(() => undefined);
				case 'reject':
					throw new Error('connect ECONNREFUSED (transport)');
				case 'rejectWithSecret':
					throw new Error(`upstream said: ${SECRET}`);
				default:
					return { ok: true, status: 200, json: async () => provider.document };
			}
		}
	};
	return provider;
};

const pluginFor = async (
	provider: FakeProvider,
	values: Record<string, unknown> = settings(),
	logger = captureLogger()
): Promise<{ plugin: OidcIdentityPlugin; logger: CapturedLogger }> => {
	const plugin = new OidcIdentityPlugin({ fetchImpl: provider.fetch });
	await plugin.onLoad(contextFor(values, logger));
	return { plugin, logger };
};

/** Every check id FR-3 turns into a row, with `ok === true` exactly when `detail` is absent. */
const expectWellFormedRows = (checks: IdentityProviderCheck[]): void => {
	expect(checks.map((check) => check.id)).toEqual([...FR3_CHECK_IDS]);
	const missingDetail = checks.filter((check) => !check.ok && typeof check.detail !== 'string');
	expect(missingDetail).toEqual([]);
	const detailOnPassingRow = checks.filter((check) => check.ok && check.detail !== undefined);
	expect(detailOnPassingRow).toEqual([]);
};

/**
 * Run a call whose first fetch attempt fails, to completion.
 *
 * FR-15's retry waits 1,000 ms on a `setTimeout` inside `discovery.ts`, so a run
 * that fails an attempt only settles once the fake clock moves. The cases where the
 * timing *is* the claim advance the clock by hand instead, so it can be asserted.
 *
 * The advance is awaited in `finally`, so it can never outlive the call and keep
 * moving the clock under a later assertion.
 */
const settleFailure = async <T>(work: Promise<T>, ms = FR15_RETRY_DELAY_MS + 100): Promise<T> => {
	const advanced = vi.advanceTimersByTimeAsync(ms);
	try {
		return await work;
	} finally {
		await advanced;
	}
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(BASE_TIME);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('Test connection — the FR-3 rows of a healthy provider', () => {
	it('reports every FR-3 check as passing, in FR-3 order', async () => {
		const { plugin } = await pluginFor(fakeProvider());
		const checks = await plugin.testConnection();

		expectWellFormedRows(checks);
		expect(checks.map((check) => check.ok)).toEqual([true, true, true, true, true, true, true]);
		expect(checks.map((check) => check.id)).toEqual([
			'discovery',
			'issuerMatch',
			'endpoints',
			'pkceS256',
			'signingAlg',
			'backchannelLogout',
			'deviceAuthorization'
		]);
	});

	it('reports the two optional capabilities as unsupported without failing the run (FR-3)', async () => {
		const provider = fakeProvider();
		delete provider.document.backchannel_logout_supported;
		delete provider.document.device_authorization_endpoint;
		const { plugin } = await pluginFor(provider);

		const checks = await plugin.testConnection();
		const byId = Object.fromEntries(checks.map((check) => [check.id, check]));

		expect(byId.backchannelLogout.ok).toBe(false);
		expect(byId.backchannelLogout.detail).toBe('The provider does not advertise back-channel logout.');
		expect(byId.deviceAuthorization.ok).toBe(false);
		expect(byId.deviceAuthorization.detail).toBe(
			'The provider does not advertise a device authorization endpoint.'
		);
		// Both rows are present (never omitted) and neither is one of the five that gate
		// availability.
		expect(checks.filter((check) => !check.ok).map((check) => check.id)).toEqual([
			'backchannelLogout',
			'deviceAuthorization'
		]);
	});

	it('names the missing endpoint, the missing S256 support and the missing algorithm separately', async () => {
		const provider = fakeProvider();
		provider.document = {
			...provider.document,
			token_endpoint: '',
			code_challenge_methods_supported: ['plain'],
			id_token_signing_alg_values_supported: ['HS256', 'PS256']
		};
		const { plugin } = await pluginFor(provider);

		const checks = await plugin.testConnection();
		const byId = Object.fromEntries(checks.map((check) => [check.id, check]));

		expect(byId.endpoints.ok).toBe(false);
		expect(byId.endpoints.detail).toBe('The discovery document is missing token_endpoint.');
		expect(byId.pkceS256.ok).toBe(false);
		expect(byId.pkceS256.detail).toBe('The provider does not advertise S256 code challenge support.');
		expect(byId.signingAlg.ok).toBe(false);
		expect(byId.signingAlg.detail).toBe('The provider advertises none of RS256, ES256 or EdDSA.');
		// The endpoints row is satisfied by any one of FR-11's algorithms.
		expect(byId.discovery.ok).toBe(true);
		expect(byId.issuerMatch.ok).toBe(true);
	});

	it('accepts ES256 and EdDSA as the advertised signing algorithm (FR-11)', async () => {
		for (const alg of ['ES256', 'EdDSA']) {
			const provider = fakeProvider();
			provider.document = { ...provider.document, id_token_signing_alg_values_supported: [alg] };
			const { plugin } = await pluginFor(provider);
			const checks = await plugin.testConnection();
			expect(checks.find((check) => check.id === 'signingAlg')?.ok, alg).toBe(true);
		}
	});

	it('reports an issuer that differs by a trailing slash as a failed issuerMatch (FR-3: exactly)', async () => {
		const provider = fakeProvider();
		provider.document = { ...provider.document, issuer: `${ISSUER}/` };
		const { plugin } = await pluginFor(provider);

		const checks = await plugin.testConnection();
		const issuerMatch = checks.find((check) => check.id === 'issuerMatch');

		expect(issuerMatch?.ok).toBe(false);
		expect(issuerMatch?.detail).toBe(
			'The issuer the provider advertises does not match the configured issuer exactly.'
		);
		// The document itself was read — the drift is the finding, not a read failure.
		expect(checks.find((check) => check.id === 'discovery')?.ok).toBe(true);
	});

	it('reports an unreachable, an erroring, a non-JSON and a malformed provider as a failed discovery row', async () => {
		const cases: Array<[FakeProvider['mode'], string]> = [
			['reject', 'The discovery document could not be reached.'],
			['http500', 'The discovery document answered HTTP 503.'],
			['invalidJson', 'The discovery document is not JSON.'],
			['hang', 'The discovery document did not answer within 5 seconds.']
		];

		for (const [mode, detail] of cases) {
			const provider = fakeProvider(mode);
			const { plugin } = await pluginFor(provider);
			// Fake timers: the hanging provider is settled by advancing the clock, not
			// by waiting. Every other mode has already answered by then.
			const pending = plugin.testConnection();
			await vi.advanceTimersByTimeAsync(FR3_BOUND_MS + FR15_RETRY_DELAY_MS);
			const checks = await pending;

			expectWellFormedRows(checks);
			expect(checks[0].ok, mode).toBe(false);
			expect(checks[0].detail, mode).toBe(detail);
			expect(
				checks
					.slice(1)
					.every((check) => check.detail === 'Not checked — the discovery document could not be read.'),
				mode
			).toBe(true);
		}
	});

	it('reports a document with no issuer as a failed discovery row', async () => {
		const provider = fakeProvider();
		provider.document = { authorization_endpoint: 'https://auth.ever.co/authorize' };
		const { plugin } = await pluginFor(provider);

		const checks = await plugin.testConnection();
		expect(checks[0].detail).toBe('The discovery document carries no issuer.');
	});

	it('reports an unconfigured integration as seven failed rows, naming the missing fields only', async () => {
		const provider = fakeProvider();
		const { plugin } = await pluginFor(provider, { issuerUrl: ISSUER, clientId: 'ever-works-web' });

		const checks = await plugin.testConnection();

		expectWellFormedRows(checks);
		expect(checks[0].detail).toBe('Not configured: clientSecret.');
		expect(
			checks.slice(1).every((check) => check.detail === 'Not checked — the integration is not configured.')
		).toBe(true);
		// Nothing was asked of the provider: an unconfigured integration does not
		// reach the network.
		expect(provider.requests).toEqual([]);
	});

	it('reports an unconfigured integration when the plugin was never loaded at all', async () => {
		const plugin = new OidcIdentityPlugin({ fetchImpl: fakeProvider().fetch });
		const checks = await plugin.testConnection();
		expect(checks[0].detail).toBe('Not configured: issuerUrl, clientId, clientSecret.');
	});

	it('treats a failing settings lookup as unconfigured rather than as an error', async () => {
		const plugin = new OidcIdentityPlugin({ fetchImpl: fakeProvider().fetch });
		const context = contextFor({});
		(context.getSettings as unknown as { mockRejectedValue: (error: Error) => void }).mockRejectedValue(
			new Error(`platform said: ${SECRET}`)
		);
		await plugin.onLoad(context);

		const checks = await plugin.testConnection();
		expect(checks[0].detail).toBe('Not configured: issuerUrl, clientId, clientSecret.');
	});
});

describe('Test connection — ACC-12-03: every FR-3 check inside 5 seconds', () => {
	it('answers within 5,000 ms of a provider that never responds, and does not retry past the bound', async () => {
		const provider = fakeProvider('hang');
		const { plugin } = await pluginFor(provider);

		const startedAt = Date.now();
		let settledAt: number | null = null;
		const pending = plugin.testConnection().then((checks) => {
			settledAt = Date.now();
			return checks;
		});

		await vi.advanceTimersByTimeAsync(FR3_BOUND_MS - 1);
		expect(settledAt).toBeNull();

		await vi.advanceTimersByTimeAsync(1);
		// Asserted before awaiting, so a run that has not answered inside the bound
		// reddens with `expected null not to be null` rather than hanging the test.
		expect(settledAt).not.toBeNull();
		const checks = await pending;

		expect((settledAt as unknown as number) - startedAt).toBe(FR3_BOUND_MS);
		expect(checks[0].ok).toBe(false);
		// FR-15's retry is *inside* FR-3's budget: a first attempt that consumed the
		// whole 5 seconds leaves no room for one, and a late answer would break the
		// bound this test exists to pin.
		expect(provider.requests).toHaveLength(1);
	});

	it('still answers within 5,000 ms when the transport ignores its abort signal', async () => {
		const provider = fakeProvider('ignoreSignal');
		const { plugin } = await pluginFor(provider);

		const startedAt = Date.now();
		let settledAt: number | null = null;
		const pending = plugin.testConnection().then((checks) => {
			settledAt = Date.now();
			return checks;
		});

		await vi.advanceTimersByTimeAsync(FR3_BOUND_MS - 1);
		expect(settledAt).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		expect(settledAt).not.toBeNull();
		const checks = await pending;

		expect((settledAt as unknown as number) - startedAt).toBe(FR3_BOUND_MS);
		expect(checks[0].detail).toBe('The discovery document did not answer within 5 seconds.');
	});

	it('retries once after exactly 1,000 ms when the first attempt failed fast (FR-15)', async () => {
		const provider = fakeProvider('http500');
		// Fail once, then answer: the retry is the only reason this run can succeed.
		const attempts = provider.requests;
		const originalFetch = provider.fetch;
		provider.fetch = async (url, init) => {
			if (attempts.length === 1) provider.mode = 'ok';
			return originalFetch(url, init);
		};
		const { plugin } = await pluginFor(provider);

		const startedAt = Date.now();
		let settledAt: number | null = null;
		const pending = plugin.testConnection().then((checks) => {
			settledAt = Date.now();
			return checks;
		});
		// The retry is a `setTimeout` (FR-15): advance well past its delay, so the two
		// request timestamps below are the claim rather than an artefact of the harness —
		// and a retry that came late would move them.
		await vi.advanceTimersByTimeAsync(FR3_BOUND_MS + FR15_RETRY_DELAY_MS);
		const checks = await pending;

		expect(provider.requests).toEqual([startedAt, startedAt + FR15_RETRY_DELAY_MS]);
		expect((settledAt as unknown as number) - startedAt).toBe(FR15_RETRY_DELAY_MS);
		expect(checks.every((check) => check.ok)).toBe(true);
	});

	it('does not retry a provider that answered — one attempt, one answer', async () => {
		const provider = fakeProvider();
		const { plugin } = await pluginFor(provider);
		await plugin.testConnection();
		expect(provider.requests).toHaveLength(1);
	});

	it('measures the bound with the injected clock, not the wall clock', async () => {
		const provider = fakeProvider();
		// A clock parked ten minutes before the fake system time: the timestamp the
		// plugin reports has to come from the injected clock, which is what proves the
		// seam is used rather than a `Date.now` read behind it.
		const injected = BASE_TIME - 600_000;
		const plugin = new OidcIdentityPlugin({ fetchImpl: provider.fetch, now: () => injected });
		await plugin.onLoad(contextFor(settings()));

		await plugin.testConnection();

		expect(plugin.getAvailability().discoveryRefreshedAt).toBe(new Date(injected).toISOString());
		expect(plugin.getAvailability().discoveryRefreshedAt).not.toBe(new Date(BASE_TIME).toISOString());
	});
});

describe('Test connection — ACC-12-03: the secret never appears in any output', () => {
	it('keeps the secret out of the serialised checks, the log lines and the public config', async () => {
		const provider = fakeProvider();
		const { plugin, logger } = await pluginFor(
			provider,
			settings({ localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }] })
		);

		const checks = await plugin.testConnection();
		const config = await plugin.getPublicConfig();

		const checksLeak = JSON.stringify(checks).includes(SECRET);
		const configLeak = JSON.stringify(config).includes(SECRET);
		const logLeak = JSON.stringify(logger.lines).includes(SECRET);
		expect({ checksLeak, configLeak, logLeak }).toEqual({ checksLeak: false, configLeak: false, logLeak: false });
		// Non-vacuity: the projection carries real values, so the three above are not
		// passing because everything is empty.
		expect(config.issuer).toBe(ISSUER);
		expect(config.localClients).toEqual([{ kind: 'cli', clientId: 'ever-works-cli' }]);
		expect(config.apiAudience).toBe('ever-works');
	});

	it('keeps a transport error that carries the secret out of every output (FR-16)', async () => {
		const provider = fakeProvider('rejectWithSecret');
		const { plugin, logger } = await pluginFor(provider);

		const checks = await settleFailure(plugin.testConnection());

		const output = JSON.stringify({ checks, logs: logger.lines });
		const leaked = output.includes(SECRET);
		expect(leaked).toBe(false);
		expect(checks[0].detail).toBe('The discovery document could not be reached.');
	});

	it('keeps the secret out of the unconfigured error path', async () => {
		const provider = fakeProvider();
		const { plugin } = await pluginFor(provider, { clientSecret: SECRET });

		let captured: unknown = null;
		try {
			await plugin.getPublicConfig();
		} catch (error) {
			const failure = error as Error & { reason?: string };
			captured = { name: failure.name, message: failure.message, reason: failure.reason };
		}

		const leaked = JSON.stringify(captured).includes(SECRET);
		expect(leaked).toBe(false);
		expect(captured).toEqual({
			name: 'OidcProviderUnavailableError',
			message: 'providerUnavailable',
			reason: 'notConfigured'
		});
	});

	it('keeps the secret out of the discovery failure returned by the reader (FR-16)', async () => {
		const reader = new OidcDiscoveryReader({
			issuerUrl: ISSUER,
			fetchImpl: fakeProvider('rejectWithSecret').fetch
		});
		const read = await settleFailure(reader.read());
		const leaked = JSON.stringify(read).includes(SECRET);
		expect(leaked).toBe(false);
		expect(read.ok).toBe(false);
	});
});

describe('getPublicConfig — FR-2’s non-secret projection', () => {
	it('returns the configured values, with FR-2’s defaults for the optional ones', async () => {
		const { plugin } = await pluginFor(
			fakeProvider(),
			settings({
				localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }],
				displayName: 'Ever ID (stage)',
				apiAudience: 'ever-works-api',
				signUpAllowed: false
			})
		);

		expect(await plugin.getPublicConfig()).toEqual({
			issuer: ISSUER,
			displayName: 'Ever ID (stage)',
			localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }],
			apiAudience: 'ever-works-api',
			signUpAllowed: false
		});
	});

	it('defaults the display name, the audience and sign-up, and never invents a field', async () => {
		const { plugin } = await pluginFor(fakeProvider());
		const config = await plugin.getPublicConfig();

		expect(config.displayName).toBe('Ever ID');
		expect(config.apiAudience).toBe('ever-works');
		expect(config.signUpAllowed).toBe(true);
		expect(config.localClients).toEqual([]);
		// The projection is the contract's five fields and no sixth: a `clientSecret`
		// key, an `allowedIssuers` echo or an availability flag would all be additive
		// surface the web reads without a spec for it.
		expect(Object.keys(config).sort()).toEqual([
			'apiAudience',
			'displayName',
			'issuer',
			'localClients',
			'signUpAllowed'
		]);
	});

	it('drops local clients that are not the contract’s shape rather than passing them on', async () => {
		const { plugin } = await pluginFor(
			fakeProvider(),
			settings({
				localClients: [
					{ kind: 'cli', clientId: 'ever-works-cli' },
					{ kind: 'browser', clientId: 'not-a-local-client' },
					{ kind: 'node', clientId: '   ' },
					{ kind: 'node', clientId: 'ever-works-node' },
					null,
					'ever-works-cli'
				]
			})
		);

		expect((await plugin.getPublicConfig()).localClients).toEqual([
			{ kind: 'cli', clientId: 'ever-works-cli' },
			{ kind: 'node', clientId: 'ever-works-node' }
		]);
	});

	it('answers providerUnavailable, never a partial config, when unconfigured', async () => {
		const { plugin } = await pluginFor(fakeProvider(), { issuerUrl: ISSUER });
		await expect(plugin.getPublicConfig()).rejects.toMatchObject({
			name: 'OidcProviderUnavailableError',
			message: 'providerUnavailable',
			reason: 'notConfigured'
		});
	});
});

describe('availability — FR-14 and plan §4.2’s unavailableSince', () => {
	it('records a drifting issuer and clears it only on a later passing run', async () => {
		const provider = fakeProvider();
		provider.document = { ...provider.document, issuer: 'https://auth.example.net' };
		const { plugin } = await pluginFor(provider);

		await plugin.testConnection();
		const afterDrift = plugin.getAvailability();
		expect(afterDrift.unavailableReason).toBe('issuerDrift');
		expect(afterDrift.unavailableSince).toBe(new Date(BASE_TIME).toISOString());

		// The provider is fixed; the next run clears the flag (and keeps the original
		// instant in between — FR-5 measures how long the provider was unusable).
		vi.setSystemTime(BASE_TIME + 120_000);
		provider.document = healthyDocument();
		const checks = await plugin.testConnection();

		expect(checks.every((check) => check.ok)).toBe(true);
		expect(plugin.getAvailability().unavailableSince).toBeNull();
		expect(plugin.getAvailability().unavailableReason).toBeNull();
		expect(plugin.getAvailability().discoveryRefreshedAt).toBe(new Date(BASE_TIME + 120_000).toISOString());
	});

	it('keeps the first failure instant while the provider stays unusable', async () => {
		const provider = fakeProvider('reject');
		const { plugin } = await pluginFor(provider);

		await settleFailure(plugin.testConnection());
		const firstInstant = plugin.getAvailability().unavailableSince;
		expect(firstInstant).not.toBeNull();
		// The instant is the run that concluded, which is when the provider became
		// known-unavailable — after FR-15's retry, not when the first attempt started.
		expect(firstInstant).toBe(new Date(BASE_TIME + OIDC_OUTBOUND_RETRY_DELAY_MS).toISOString());

		vi.setSystemTime(BASE_TIME + 30_000);
		await settleFailure(plugin.testConnection());

		expect(plugin.getAvailability().unavailableSince).toBe(firstInstant);
		expect(plugin.getAvailability().unavailableReason).toBe('discoveryFailed');
	});

	it('does not treat a missing optional capability as unavailability (FR-3)', async () => {
		const provider = fakeProvider();
		delete provider.document.backchannel_logout_supported;
		delete provider.document.device_authorization_endpoint;
		const { plugin } = await pluginFor(provider);

		await plugin.testConnection();
		expect(plugin.getAvailability().unavailableSince).toBeNull();
	});

	it('treats an incomplete discovery document as unavailable', async () => {
		const provider = fakeProvider();
		provider.document = { ...provider.document, code_challenge_methods_supported: [] };
		const { plugin } = await pluginFor(provider);

		await plugin.testConnection();
		expect(plugin.getAvailability().unavailableSince).toBe(new Date(BASE_TIME).toISOString());
		expect(plugin.getAvailability().unavailableReason).toBe('discoveryFailed');
	});
});

describe('the discovery cache — FR-14’s 3,600 seconds', () => {
	it('serves the cached document inside 3,600 s and re-reads after it', async () => {
		const provider = fakeProvider();
		const reader = new OidcDiscoveryReader({ issuerUrl: ISSUER, fetchImpl: provider.fetch });

		await reader.get();
		expect(provider.requests).toHaveLength(1);

		vi.setSystemTime(BASE_TIME + OIDC_DISCOVERY_CACHE_SECONDS * 1_000 - 1);
		await reader.get();
		expect(provider.requests).toHaveLength(1);
		expect(reader.cachedDocument()).not.toBeNull();

		vi.setSystemTime(BASE_TIME + OIDC_DISCOVERY_CACHE_SECONDS * 1_000);
		await reader.get();
		expect(provider.requests).toHaveLength(2);
	});

	it('always re-reads for Test connection, so a cached answer cannot pass a re-test (FR-14)', async () => {
		const provider = fakeProvider();
		const { plugin } = await pluginFor(provider);

		await plugin.testConnection();
		await plugin.testConnection();
		await plugin.testConnection();

		expect(provider.requests).toHaveLength(3);
	});

	it('refuses a drifted issuer on the flow path but hands the document to Test connection', async () => {
		const provider = fakeProvider();
		provider.document = { ...provider.document, issuer: 'https://auth.example.net' };
		const reader = new OidcDiscoveryReader({ issuerUrl: ISSUER, fetchImpl: provider.fetch });

		const read = await reader.read();
		expect(read.ok).toBe(true);
		expect(read.ok && read.issuerMatches).toBe(false);
		await expect(reader.get()).rejects.toMatchObject({ reason: 'issuerDrift' });
	});

	it('refuses an unreadable document on the flow path rather than returning null', async () => {
		const reader = new OidcDiscoveryReader({ issuerUrl: ISSUER, fetchImpl: fakeProvider('reject').fetch });
		await expect(settleFailure(reader.get())).rejects.toMatchObject({ reason: 'discoveryFailed' });
	});

	it('refuses an issuer that is not an address a document can be read from', async () => {
		const provider = fakeProvider();
		const reader = new OidcDiscoveryReader({ issuerUrl: 'auth.ever.co', fetchImpl: provider.fetch });

		const read = await reader.read();
		expect(read.ok).toBe(false);
		expect(read.ok === false && read.failure).toBe('invalidIssuer');
		// Fail closed without touching the network: an address we cannot build is not
		// an address we may guess at (FR-2 refuses it at write time).
		expect(provider.requests).toEqual([]);
	});
});

describe('the transcribed §4.3 numbers still match EVER_ID_LIMITS', () => {
	const contractsSource = readFileSync(
		new URL('../../../../contracts/src/apps/ever-id.ts', import.meta.url),
		'utf-8'
	);

	const limitValue = (key: string): number => {
		const match = new RegExp(`\\b${key}:\\s*([0-9_]+)`, 'u').exec(contractsSource);
		expect(match, `${key} not found in EVER_ID_LIMITS`).not.toBeNull();
		return Number((match as RegExpExecArray)[1].replaceAll('_', ''));
	};

	it('mirrors the outbound timeout, the retry delay and the discovery cache', () => {
		expect(OIDC_OUTBOUND_TIMEOUT_MS).toBe(limitValue('outboundTimeoutMs'));
		expect(OIDC_DISCOVERY_CACHE_SECONDS).toBe(limitValue('discoveryCacheSeconds'));
		// FR-15's retry delay is the one §4.3 number with no `EVER_ID_LIMITS` key: the
		// table states "one retry after 1,000 ms" in prose, so it is pinned literally.
		expect(OIDC_OUTBOUND_RETRY_DELAY_MS).toBe(1_000);
	});

	it('mirrors the signing algorithms of FR-11', () => {
		const match = /EVER_ID_SIGNING_ALGS = \[([^\]]+)\]/u.exec(contractsSource);
		expect(match).not.toBeNull();
		const algs = (match as RegExpExecArray)[1]
			.split(',')
			.map((value) => value.trim().replaceAll("'", ''))
			.filter((value) => value.length > 0);
		expect([...OIDC_IDENTITY_SIGNING_ALGS]).toEqual(algs);
	});

	it('pins the five required checks and the two reported-only ones', () => {
		expect([...FR3_REQUIRED_CHECK_IDS]).toEqual([
			'discovery',
			'issuerMatch',
			'endpoints',
			'pkceS256',
			'signingAlg'
		]);
		expect(FR3_CHECK_IDS.filter((id) => !FR3_REQUIRED_CHECK_IDS.includes(id))).toEqual([
			'backchannelLogout',
			'deviceAuthorization'
		]);
	});
});
