/**
 * APW-12 T4 — the `identity-provider` capability, the `identity` category and
 * `IIdentityProviderPlugin` (plan §4.1:333–417).
 *
 * `identity-provider.interface.ts` is pinned by its own compile-time shape: the
 * fixture below is annotated with the plan's types, so a member the plan names
 * cannot be renamed, made nullable or dropped — and a member the plan does NOT
 * name cannot be added to a shape a plugin returns — without
 * `tsc -p tsconfig.specs.json` failing. What this spec exists for is the four
 * things a capability can silently get wrong:
 *
 *  1. **the constant and the category are the strings the plan names**, so the
 *     `oidc-identity` manifest (`category: 'identity'`,
 *     `capabilities: ['identity-provider']`), the facade's resolution
 *     (`PLUGIN_CAPABILITIES.IDENTITY_PROVIDER`) and the web's category maps all
 *     agree (plan §4.1:335–337);
 *  2. **nothing was removed to make room for it.** `PLUGIN_CAPABILITIES` and
 *     `PLUGIN_CATEGORIES` are append-only surfaces: a member that disappears
 *     silently breaks every manifest that declares it, and the failure shows up
 *     as a plugin that loads with fewer capabilities than it has — never as an
 *     error. `EXISTING_CAPABILITIES` / `PRE_IDENTITY_CATEGORIES` below are the
 *     pre-T4 snapshot taken from `HEAD`, and the category is pinned to sit
 *     immediately after that block, so a **mid-tuple insertion fails here**;
 *  3. **the rejection code set is closed and leaks nothing.** The class exists
 *     because a TypeScript union cannot be enforced at runtime, and FR-16 forbids
 *     a token, code, verifier or nonce from reaching a log, an Activity row or an
 *     error message — so the message is asserted to be the code and nothing else;
 *  4. **the guard refuses a manifest that only claims the capability.** The
 *     `oidc-identity` package (T5) declares `identity-provider` with no method
 *     implemented on purpose, and the facade must be fail-closed until T6 puts the
 *     flow behind it.
 */

import { describe, expect, it } from 'vitest';
import { PLUGIN_CATEGORIES, isPluginCategory, type PluginCategory } from '../plugin-manifest.types.js';
import { PLUGIN_CAPABILITIES, isValidPluginCapability, type PluginCapability } from '../facade-capabilities.js';
import {
	IDENTITY_TOKEN_REJECTION_CODES,
	IdentityTokenRejectedError,
	isIdentityProviderPlugin,
	type IdentityProviderCheck,
	type IIdentityProviderPlugin,
	type IdentityTokenRejectionCode,
	type VerifiedAccessTokenClaims,
	type VerifiedIdTokenClaims,
	type VerifiedLogoutTokenClaims
} from '../capabilities/identity-provider.interface.js';
import * as contractsBarrel from '../index.js';
import type { JsonSchema } from '../../settings/json-schema.types.js';
import type { IPlugin } from '../plugin.interface.js';

/**
 * Every capability VALUE that existed before APW-12 T4 appended
 * `identity-provider`, in `facade-capabilities.ts`'s own order.
 *
 * Taken from that file at `HEAD` rather than hand-written: the capability values
 * are not the category names (`form-schema-provider`, not `form`;
 * `metrics-provider`, not `metrics`), so a snapshot written from the category
 * tuple fails on its own list.
 */
const EXISTING_CAPABILITIES = [
	'ai-provider',
	'search',
	'screenshot',
	'content-extractor',
	'data-source',
	'pipeline',
	'pipeline-modifier',
	'code-edit',
	'form-schema-provider',
	'deployment',
	'git-provider',
	'oauth',
	'device-auth',
	'prompt-provider',
	'storage',
	'put-object',
	'get-object',
	'presigned-put',
	'skills-provider',
	'task-tracker',
	'email-outbound',
	'email-inbound',
	'notification-channel',
	'notification-channel-discord',
	'notification-channel-slack',
	'notification-channel-telegram',
	'notification-channel-whatsapp',
	'notification-channel-novu',
	'connector',
	'connector-slack',
	'connector-discord',
	'connector-whatsapp',
	'connector-linear',
	'connector-notion',
	'connector-microsoft-365',
	'connector-hubspot',
	'connector-pipedrive',
	'connector-bluesky',
	'connector-mastodon',
	'agent-memory',
	'metrics-provider',
	'terminal-stream',
	'workspace',
	'browser-automation',
	'event-source',
	'playbook-provider',
	'connection-scopes',
	'app-dependency',
	'build'
] as const;

/**
 * Every category that existed before the same change, in the tuple's own order:
 * the 24-member pre-APW-07 block plus APW-07 T3's `app-dependency` and APW-05 T2's
 * `build`. Also taken from `HEAD`.
 */
const PRE_IDENTITY_CATEGORIES = [
	'git-provider',
	'deployment',
	'screenshot',
	'search',
	'content-extractor',
	'data-source',
	'ai-provider',
	'pipeline',
	'form',
	'integration',
	'utility',
	'theme',
	'storage',
	'database',
	'email-provider',
	'notification-channel',
	'connector',
	'vector-store',
	'dns',
	'secret-store-resolver',
	'job-runtime',
	'memory',
	'rag',
	'metrics',
	'app-dependency',
	'build'
] as const;

/**
 * Every capability a LATER epic appended behind `identity-provider`, in the
 * map's own order — APW-10 T2 added `apps-tier` (which appends no category).
 *
 * This spec owns `identity-provider`; the list exists so the append-only
 * assertion below stays a statement about *this* change rather than about the
 * map's current tail — the same extension point `build-capability.spec.ts:164`
 * carries. An epic that appends behind `identity-provider` extends it in the
 * same change, so the total stays exact instead of drifting, and the next append
 * is one token here rather than a red suite. Nothing is weakened:
 * `EXISTING_CAPABILITIES` is still compared member by member, `identity-provider`
 * is still counted exactly once, and a member that disappears or is renamed
 * still fails the total.
 */
const LATER_CAPABILITIES: readonly string[] = ['apps-tier'];

/** The seven **Test connection** ids of FR-3, in its order (plan §4.1:340–351). */
const EVERY_CHECK_ID: readonly IdentityProviderCheck['id'][] = [
	'discovery',
	'issuerMatch',
	'endpoints',
	'pkceS256',
	'signingAlg',
	'backchannelLogout',
	'deviceAuthorization'
];

/** Every member the guard checks, so "one method missing" can be tried for each. */
const EVERY_METHOD: readonly (keyof IIdentityProviderPlugin)[] = [
	'testConnection',
	'getPublicConfig',
	'buildAuthorizationRequest',
	'exchangeAuthorizationCode',
	'verifyAccessToken',
	'verifyLogoutToken',
	'buildEndSessionUrl'
];

/* ─────────────────────────── typed fixtures ─────────────────────────── */

const idTokenClaims: VerifiedIdTokenClaims = {
	issuer: 'https://id.ever.works',
	subject: 'subject-0001',
	email: 'member@example.com',
	emailVerified: true,
	name: 'Member',
	authTime: 1_767_225_600,
	sid: 'ever-id-session-0001'
};

const accessTokenClaims: VerifiedAccessTokenClaims = {
	issuer: 'https://id.ever.works',
	subject: 'subject-0001',
	audience: ['ever-works'],
	scopes: ['ever-works:session'],
	authorizedParty: 'ever-works-cli',
	issuedAt: 1_767_225_600,
	expiresAt: 1_767_225_900,
	jti: 'jti-0001'
};

const logoutTokenClaims: VerifiedLogoutTokenClaims = {
	issuer: 'https://id.ever.works',
	subject: 'subject-0001',
	sid: 'ever-id-session-0001',
	jti: 'jti-0002'
};

const checks: IdentityProviderCheck[] = [
	{ id: 'discovery', ok: true },
	{ id: 'issuerMatch', ok: true, detail: 'issuer is the configured issuer exactly' },
	{ id: 'endpoints', ok: true },
	{ id: 'pkceS256', ok: true },
	{ id: 'signingAlg', ok: true, detail: 'RS256' },
	{ id: 'backchannelLogout', ok: true },
	{ id: 'deviceAuthorization', ok: false, detail: 'the provider publishes no device authorization endpoint' }
];

/** A complete identity provider: every one of the plan's seven methods, and nothing invented. */
const provider: IIdentityProviderPlugin = {
	id: 'oidc-identity',
	name: 'OpenID Connect identity (Ever ID)',
	version: '1.0.0',
	category: 'identity',
	capabilities: [PLUGIN_CAPABILITIES.IDENTITY_PROVIDER],
	configurationMode: 'admin-only',
	settingsSchema: {} as JsonSchema,
	onLoad: async () => undefined,
	onUnload: async () => undefined,
	testConnection: async () => checks,
	getPublicConfig: async () => ({
		issuer: 'https://id.ever.works',
		displayName: 'Ever ID',
		localClients: [
			{ kind: 'cli', clientId: 'ever-works-cli' },
			{ kind: 'node', clientId: 'ever-works-node' }
		],
		apiAudience: 'ever-works',
		signUpAllowed: true
	}),
	buildAuthorizationRequest: async () => ({
		url: 'https://id.ever.works/authorize?client_id=ever-works-web',
		state: 'state-0001',
		nonce: 'nonce-0001',
		codeVerifier: 'verifier-0001'
	}),
	exchangeAuthorizationCode: async () => idTokenClaims,
	verifyAccessToken: async () => accessTokenClaims,
	verifyLogoutToken: async () => logoutTokenClaims,
	buildEndSessionUrl: async () => null
};

/* ─────────────── the capability and the category (plan §4.1:335–337) ─────────────── */

describe('the identity-provider capability (APW-12 T4)', () => {
	it('names the capability exactly as the plan does', () => {
		expect(PLUGIN_CAPABILITIES.IDENTITY_PROVIDER).toBe('identity-provider');
		const capability: PluginCapability = PLUGIN_CAPABILITIES.IDENTITY_PROVIDER;
		expect(capability).toBe('identity-provider');
		expect(isValidPluginCapability('identity-provider')).toBe(true);
		// A near miss must stay invalid: the guard is what plugin manifests are
		// validated against, so a plural or camelCase alias cannot exist.
		expect(isValidPluginCapability('identity-providers')).toBe(false);
		expect(isValidPluginCapability('identityProvider')).toBe(false);
		// `identity` is the CATEGORY, not a capability — the two surfaces are one
		// spelling apart on purpose, and swapping them is a manifest that never lists.
		expect(isValidPluginCapability('identity')).toBe(false);
		expect(isValidPluginCapability(undefined)).toBe(false);
	});

	it('keeps every pre-existing capability present', () => {
		const values = Object.values(PLUGIN_CAPABILITIES) as readonly string[];
		for (const capability of EXISTING_CAPABILITIES) {
			expect(values, capability).toContain(capability);
		}
		// Exactly one member was added, and it is this one.
		expect(values.filter((entry) => entry === 'identity-provider')).toHaveLength(1);
		// …and everything a later epic appended behind it is present and valid, so the
		// count below stays an exact total rather than a number that drifts.
		for (const capability of LATER_CAPABILITIES) {
			expect(values, capability).toContain(capability);
			expect(isValidPluginCapability(capability), capability).toBe(true);
		}
		expect(values).toHaveLength(EXISTING_CAPABILITIES.length + 1 + LATER_CAPABILITIES.length);
	});

	it('appends the category without removing, reordering or duplicating a member', () => {
		expect(PLUGIN_CATEGORIES).toContain('identity');

		// The append-only guarantee, asserted rather than assumed: every pre-existing
		// member is still there, in the same relative order, exactly once.
		const remaining = PLUGIN_CATEGORIES.filter((entry) => entry !== 'identity');
		expect(remaining).toEqual([...PRE_IDENTITY_CATEGORIES]);
		expect(new Set(PLUGIN_CATEGORIES).size).toBe(PLUGIN_CATEGORIES.length);

		// …and it sits immediately after the block that preceded it, which is what
		// "append" means here: a category inserted in the middle renumbers every index
		// a consumer persisted, and a category that displaced `build` would move the
		// member APW-05 T2 pinned. Both a MID-TUPLE INSERTION and a REORDER fail here.
		expect(PLUGIN_CATEGORIES.indexOf('identity')).toBe(PRE_IDENTITY_CATEGORIES.length);
		expect(PLUGIN_CATEGORIES.slice(0, PRE_IDENTITY_CATEGORIES.length)).toEqual([...PRE_IDENTITY_CATEGORIES]);

		// The derived union follows the tuple.
		const asCategory: PluginCategory = 'identity';
		expect(PLUGIN_CATEGORIES).toContain(asCategory);
	});

	it('accepts the category through the loader guard and refuses a near miss', () => {
		// `isPluginCategory` is what plugin-manifest-validator.service.ts:89 and
		// plugin-class-validator.service.ts:30 consult before a discovered plugin is
		// accepted, so this is the check that turns `oidc-identity` from a skipped
		// package into a discovered one.
		expect(isPluginCategory('identity')).toBe(true);
		expect(isPluginCategory('identity-provider')).toBe(false);
		expect(isPluginCategory('identities')).toBe(false);
		expect(isPluginCategory('Identity')).toBe(false);
	});
});

/* ─────────────── the closed rejection vocabulary (plan §4.1:414–417) ─────────────── */

describe('the closed IdentityTokenRejectedError code set (APW-12 T4)', () => {
	it("carries exactly the codes the plan names, in the plan's order", () => {
		expect(IDENTITY_TOKEN_REJECTION_CODES).toEqual([
			'badSignature',
			'badIssuer',
			'badAudience',
			'expired',
			'notYetValid',
			'tooOld',
			'badNonce',
			'badAlg',
			'missingScope',
			'lifetimeTooLong',
			'badAuthorizedParty',
			'badLogoutEvent',
			'nonceInLogoutToken',
			'providerUnavailable'
		]);
		// Closed means no duplicates either: a repeated member would make a count-based
		// caller (the facade's per-code counter, §9.1) report one reason twice.
		expect(new Set(IDENTITY_TOKEN_REJECTION_CODES).size).toBe(IDENTITY_TOKEN_REJECTION_CODES.length);
	});

	it('answers with the code alone — never token material', () => {
		for (const code of IDENTITY_TOKEN_REJECTION_CODES) {
			const error = new IdentityTokenRejectedError(code);
			// FR-16: the message is the code and nothing else, so a provider's own error
			// text, an HTTP status or a claim dump can never ride along into a log,
			// an Activity row or a response body.
			expect(error.message, code).toBe(code);
			// A crude but real second reading of the same rule: no run of 20+
			// token-shaped characters anywhere in the message.
			expect(error.message, code).not.toMatch(/[A-Za-z0-9._~+/-]{20,}/);
		}
	});

	it('is an Error, so a caller that catches it degrades to a refusal', () => {
		const error = new IdentityTokenRejectedError('badSignature');
		expect(error).toBeInstanceOf(Error);
		// C28: it used to keep the default name 'Error', so a log could not name the type
		// (unlike this package's other errors). The pin now asserts the fix.
		expect(error.name).toBe('IdentityTokenRejectedError');
		expect(error.code).toBe('badSignature');
		// The union is derived from the tuple, so both spell the same member set.
		const everyCode: readonly IdentityTokenRejectionCode[] = [...IDENTITY_TOKEN_REJECTION_CODES];
		expect(everyCode).toHaveLength(IDENTITY_TOKEN_REJECTION_CODES.length);
	});

	it('refuses a code outside the set at the type level', () => {
		// @ts-expect-error `badToken` is not a member: a provider that invents a code
		// must be a compile error, never a runtime string the facade cannot map (§5.2).
		const invented: IdentityTokenRejectionCode = 'badToken';
		expect(invented as string).toBe('badToken');

		// @ts-expect-error the constructor takes the closed union, not `string`.
		const fromRawText = new IdentityTokenRejectedError('Signature verification failed');
		expect(fromRawText).toBeInstanceOf(Error);
	});
});

/* ─────────────── the interface, the guard and the barrel (§4.1:377–411) ─────────────── */

describe('isIdentityProviderPlugin (APW-12 T4)', () => {
	it('accepts a plugin that declares the capability and all seven methods', () => {
		expect(isIdentityProviderPlugin(provider)).toBe(true);
	});

	it('refuses a plugin that claims the capability but is missing a method', () => {
		for (const method of EVERY_METHOD) {
			const { [method]: _dropped, ...withoutMethod } = provider;
			expect(isIdentityProviderPlugin(withoutMethod as unknown as IPlugin), method).toBe(false);
		}
	});

	it('requires the capability itself, not just the shape', () => {
		expect(
			isIdentityProviderPlugin({
				...provider,
				capabilities: [PLUGIN_CAPABILITIES.DEPLOYMENT]
			})
		).toBe(false);
	});

	it('refuses the T5 scaffold — a manifest with nothing behind it', () => {
		// `packages/plugins/oidc-identity` (APW-12 T5) declares exactly this: the
		// category and the capability, and no method at all, because nothing may
		// pretend to answer Test connection before T6 writes the real flow. The guard
		// answering `false` here is what keeps the facade fail-closed in between.
		const scaffold = {
			id: 'oidc-identity',
			name: 'OpenID Connect identity (Ever ID)',
			version: '1.0.0',
			category: 'identity',
			capabilities: ['identity-provider'],
			settingsSchema: {},
			onLoad: async () => undefined,
			onUnload: async () => undefined
		} as unknown as IPlugin;
		expect(isIdentityProviderPlugin(scaffold)).toBe(false);
	});

	it('refuses a capability list that is not a list, and a plugin that is not there', () => {
		expect(isIdentityProviderPlugin({ capabilities: 'identity-provider' } as unknown as IPlugin)).toBe(false);
		expect(isIdentityProviderPlugin(undefined as unknown as IPlugin)).toBe(false);
	});

	it('is reachable through the contracts barrel the package publishes', () => {
		// `contracts/index.ts` re-exports `capabilities/index.ts`, which is the path
		// `@ever-works/plugin/contracts` serves: a module that is not on that path is a
		// capability no consumer can import.
		expect(typeof contractsBarrel.isIdentityProviderPlugin).toBe('function');
		expect(contractsBarrel.IdentityTokenRejectedError).toBe(IdentityTokenRejectedError);
		expect(contractsBarrel.IDENTITY_TOKEN_REJECTION_CODES).toEqual([...IDENTITY_TOKEN_REJECTION_CODES]);
	});
});

/* ─────────────── the transcribed shapes (plan §4.1:340–410) ─────────────── */

describe('the shapes the plan transcribes (APW-12 T4)', () => {
	it('lists the seven Test connection ids FR-3 names, in order', () => {
		expect(checks.map((check) => check.id)).toEqual([...EVERY_CHECK_ID]);
		expect(new Set(checks.map((check) => check.id)).size).toBe(EVERY_CHECK_ID.length);

		const misspelled: IdentityProviderCheck = {
			// @ts-expect-error FR-3 spells the id `backchannelLogout`, not `backchannel-logout`
			id: 'backchannel-logout',
			ok: false
		};
		expect(EVERY_CHECK_ID).not.toContain(misspelled.id as string);
	});

	it('answers exactly the claim fields the plan writes, and no others', async () => {
		expect(
			Object.keys(
				await provider.exchangeAuthorizationCode({
					code: 'code-0001',
					redirectUri: 'https://app.ever.works/api/auth/ever-id/callback',
					codeVerifier: 'verifier-0001',
					expectedNonce: 'nonce-0001',
					receivedIssuer: 'https://id.ever.works',
					maxAuthAgeSeconds: 300
				})
			)
		).toEqual(['issuer', 'subject', 'email', 'emailVerified', 'name', 'authTime', 'sid']);

		expect(
			Object.keys(
				await provider.verifyAccessToken('access-token-0001', {
					requiredScopes: ['ever-works:session'],
					maxLifetimeSeconds: 3_600,
					maxAgeSeconds: 300,
					allowedAuthorizedParties: ['ever-works-cli', 'ever-works-node']
				})
			)
		).toEqual(['issuer', 'subject', 'audience', 'scopes', 'authorizedParty', 'issuedAt', 'expiresAt', 'jti']);

		expect(Object.keys(await provider.verifyLogoutToken('logout-token-0001'))).toEqual([
			'issuer',
			'subject',
			'sid',
			'jti'
		]);

		// The three nullable members are nullable on purpose (FR-22/FR-23 branch on
		// them), and the three required ones are required: a caller may not have to
		// guess whether "no e-mail" is `null` or `''`.
		const noEmail: VerifiedIdTokenClaims = { ...idTokenClaims, email: null, emailVerified: false, authTime: null };
		expect(noEmail.email).toBeNull();
		// @ts-expect-error `subject` is the pair's other half (FR-21) and is never null
		const subjectless: VerifiedIdTokenClaims = { ...idTokenClaims, subject: null };
		expect(subjectless.subject).toBeNull();
		// @ts-expect-error a logout token without `jti` cannot honour FR-33's replay window
		const noJti: VerifiedLogoutTokenClaims = { issuer: logoutTokenClaims.issuer, subject: null, sid: null };
		expect(noJti.jti).toBeUndefined();
	});

	it('projects only non-secret configuration into getPublicConfig (FR-16)', async () => {
		const publicConfig = await provider.getPublicConfig();
		expect(Object.keys(publicConfig)).toEqual([
			'issuer',
			'displayName',
			'localClients',
			'apiAudience',
			'signUpAllowed'
		]);
		// The two local-client kinds FR-39 names, and no client secret anywhere.
		expect(publicConfig.localClients.map((client) => client.kind)).toEqual(['cli', 'node']);
		expect(JSON.stringify(publicConfig)).not.toMatch(/secret/i);
	});
});
