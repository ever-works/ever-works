/**
 * APW-12 (Ever ID) — the shared harness of the API's Ever ID integration specs.
 *
 * Named `*.helper-spec.ts` on purpose: the build excludes every `*spec.ts`, and
 * Jest's `.spec.ts` pattern does not pick it up as a suite of its own.
 *
 * It boots the real `EverIdController`, the real Ever ID services, the real
 * `AuthSessionGuard` (as the global guard, exactly as the API registers it) and
 * the real `AuthProviderService` session path over an in-memory better-sqlite3
 * database, and wires the real `IdentityProviderFacadeService` to a stand-in
 * identity provider plugin that speaks plain OpenID Connect over HTTP to the
 * `oidc-identity` package's own fake provider.
 *
 * Why a stand-in plugin rather than the published one: the published plugin
 * depends on ESM-only libraries Jest's CommonJS runtime cannot load. The
 * stand-in performs the same wire protocol (discovery, PKCE S256 authorization,
 * `client_secret_basic` code exchange, JWKS ES256 verification, the FR-11 /
 * FR-33 / FR-40 / FR-45 claim checks) with `node:crypto`, and throws refusals
 * shaped like the published plugin's (a foreign `IdentityTokenRejectedError`),
 * so the facade's normalisation is exercised too. The published plugin's own
 * behaviour is pinned by its Vitest suite against the same fake provider.
 */
import {
    Controller,
    Get,
    INestApplication,
    Request,
    ValidationPipe,
    type Provider,
    type Type,
} from '@nestjs/common';
import * as request from 'supertest';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { DataSource } from 'typeorm';
import {
    ENTITIES,
    ExternalIdentityRepository,
    OrganizationRepository,
    UserRepository,
} from '@ever-works/agent/database';
import { ExternalIdentity, Organization, User } from '@ever-works/agent/entities';
import { IdentityProviderFacadeService } from '@ever-works/agent/facades';
import { PluginRegistryService } from '@ever-works/agent/plugins';
import type {
    IIdentityProviderPlugin,
    IdentityProviderCheck,
    VerifiedAccessTokenClaims,
    VerifiedIdTokenClaims,
    VerifiedLogoutTokenClaims,
} from '@ever-works/plugin';
import { FakeOidcProvider } from '../../../../../packages/plugins/oidc-identity/src/testing/fake-oidc-provider';
import { DelegatedRead } from '../decorators/delegated-read.decorator';
import { EverIdAdminGuard, EverIdController } from '../controllers/ever-id.controller';
import { AuthSessionGuard } from '../guards/auth-session.guard';
import {
    EVER_ID_DELEGATION_VERIFIER,
    EVER_ID_SIGNED_OUT_PROBE,
} from '../guards/ever-id-guard.tokens';
import { AUTH_PROVIDER } from '../providers/auth-provider.constants';
import { AuthProviderService } from '../providers/auth-provider.service';
import { ApiKeyService } from '../services/api-key.service';
import { EverIdActivityService } from '../services/ever-id-activity.service';
import { EverIdBackchannelService } from '../services/ever-id-backchannel.service';
import { EverIdClaimHintsService } from '../services/ever-id-claims-hints';
import { EverIdDelegationService } from '../services/ever-id-delegation.service';
import { EverIdLinkingService } from '../services/ever-id-linking.service';
import { EverIdReplayService } from '../services/ever-id-replay.service';
import { EverIdSealService } from '../services/ever-id-seal.service';
import { EverIdSessionService } from '../services/ever-id-session.service';
import { EverIdSignInService } from '../services/ever-id-sign-in.service';
import { EverIdTelemetryService } from '../services/ever-id-telemetry.service';
import { UsernameAllocatorService } from '../../users/services/username-allocator.service';

export const TEST_WEB_URL = 'https://app.example.test';
export const TEST_AUTH_SECRET = 'test-secret-that-is-at-least-thirty-two-characters-long';
export const TEST_API_KEY = 'ew_live_test-key';
export const TERMS = [
    { documentId: 'tos:ever-works', version: '1.0.0', sha256: 'a'.repeat(64), locale: 'en' },
    { documentId: 'privacy:ever-works', version: '1.0.0', sha256: 'b'.repeat(64), locale: 'en' },
];

/** What the stand-in plugin is configured with (the settings an administrator or the environment provides). */
export interface TestProviderSettings {
    issuerUrl?: string;
    clientId?: string;
    clientSecret?: string;
    apiAudience?: string;
    signUpAllowed?: boolean;
    localClients?: Array<{ kind: 'cli' | 'node'; clientId: string }>;
    delegatedClientNames?: Array<{ clientId: string; displayName: string }>;
    accountManagementUrl?: string;
    displayName?: string;
    clockSkewSeconds?: number;
}

function rejection(code: string): Error {
    // Shaped like the published plugin's own (bundled) class, on purpose.
    return Object.assign(new Error(code), { name: 'IdentityTokenRejectedError', code });
}

function notConfigured(): Error {
    return Object.assign(new Error('providerUnavailable'), {
        name: 'OidcProviderUnavailableError',
        reason: 'notConfigured',
    });
}

function decodePart(part: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * A plain OpenID Connect relying party over `fetch` + `node:crypto` — see the file
 * header for why it stands in for the published plugin here.
 */
export class TestIdentityProviderPlugin implements IIdentityProviderPlugin {
    readonly id = 'test-identity';
    readonly name = 'Test identity';
    readonly version = '1.0.0';
    readonly category = 'identity' as never;
    readonly capabilities = ['identity-provider'];
    readonly configurationMode = 'admin-only';
    readonly settingsSchema = {
        type: 'object',
        properties: {
            issuerUrl: { type: 'string' },
            clientId: { type: 'string' },
            clientSecret: { type: 'string', 'x-secret': true },
        },
        required: ['issuerUrl', 'clientId', 'clientSecret'],
    } as never;

    constructor(private readonly settings: () => TestProviderSettings) {}

    async onLoad(): Promise<void> {}
    async onUnload(): Promise<void> {}

    private configured(): Required<
        Pick<TestProviderSettings, 'issuerUrl' | 'clientId' | 'clientSecret'>
    > &
        TestProviderSettings {
        const settings = this.settings();
        if (!settings.issuerUrl || !settings.clientId || !settings.clientSecret)
            throw notConfigured();
        return settings as never;
    }

    private async discovery(): Promise<Record<string, unknown>> {
        const { issuerUrl } = this.configured();
        const response = await fetch(`${issuerUrl}/.well-known/openid-configuration`);
        if (!response.ok) throw Object.assign(new Error('x'), { reason: 'discoveryFailed' });
        return (await response.json()) as Record<string, unknown>;
    }

    async testConnection(): Promise<IdentityProviderCheck[]> {
        const { issuerUrl } = this.configured();
        let document: Record<string, unknown> | null = null;
        try {
            document = await this.discovery();
        } catch {
            document = null;
        }
        const ids: IdentityProviderCheck['id'][] = [
            'discovery',
            'issuerMatch',
            'endpoints',
            'pkceS256',
            'signingAlg',
            'backchannelLogout',
            'deviceAuthorization',
        ];
        if (!document) return ids.map((id) => ({ id, ok: false, detail: 'Discovery failed.' }));
        const ok: Record<string, boolean> = {
            discovery: true,
            issuerMatch: document.issuer === issuerUrl,
            endpoints:
                !!document.authorization_endpoint &&
                !!document.token_endpoint &&
                !!document.jwks_uri,
            pkceS256: Array.isArray(document.code_challenge_methods_supported)
                ? (document.code_challenge_methods_supported as string[]).includes('S256')
                : false,
            signingAlg: true,
            backchannelLogout: document.backchannel_logout_supported === true,
            deviceAuthorization: typeof document.device_authorization_endpoint === 'string',
        };
        return ids.map((id) => ({ id, ok: ok[id] }));
    }

    async getPublicConfig() {
        const settings = this.configured();
        return {
            issuer: settings.issuerUrl,
            displayName: settings.displayName ?? 'Ever ID',
            localClients: settings.localClients ?? [],
            apiAudience: settings.apiAudience ?? 'ever-works',
            signUpAllowed: settings.signUpAllowed !== false,
        };
    }

    async buildAuthorizationRequest(input: {
        redirectUri: string;
        prompt?: 'login';
        maxAgeSeconds?: number;
    }) {
        const { clientId } = this.configured();
        const document = await this.discovery();
        const state = randomBytes(32).toString('base64url');
        const nonce = randomBytes(32).toString('base64url');
        const codeVerifier = randomBytes(48).toString('base64url');
        const url = new URL(String(document.authorization_endpoint));
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('redirect_uri', input.redirectUri);
        url.searchParams.set('scope', 'openid email profile');
        url.searchParams.set('state', state);
        url.searchParams.set('nonce', nonce);
        url.searchParams.set(
            'code_challenge',
            createHash('sha256').update(codeVerifier).digest('base64url'),
        );
        url.searchParams.set('code_challenge_method', 'S256');
        if (input.prompt) url.searchParams.set('prompt', input.prompt);
        if (input.maxAgeSeconds !== undefined)
            url.searchParams.set('max_age', String(input.maxAgeSeconds));
        return { url: url.toString(), state, nonce, codeVerifier };
    }

    async exchangeAuthorizationCode(input: {
        code: string;
        redirectUri: string;
        codeVerifier: string;
        expectedNonce: string;
        receivedIssuer?: string;
        maxAuthAgeSeconds?: number;
    }): Promise<VerifiedIdTokenClaims> {
        const settings = this.configured();
        if (input.receivedIssuer !== undefined && input.receivedIssuer !== settings.issuerUrl) {
            throw rejection('badIssuer');
        }
        const document = await this.discovery();
        const response = await fetch(String(document.token_endpoint), {
            method: 'POST',
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
                authorization: `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString('base64')}`,
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: input.code,
                redirect_uri: input.redirectUri,
                code_verifier: input.codeVerifier,
            }).toString(),
        });
        if (!response.ok) throw rejection('badSignature');
        const tokens = (await response.json()) as { id_token: string };
        const payload = await this.verifyJws(tokens.id_token, document);
        const now = Math.floor(Date.now() / 1000);
        const skew = settings.clockSkewSeconds ?? 60;
        if (payload.iss !== settings.issuerUrl) throw rejection('badIssuer');
        const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        if (!audiences.includes(settings.clientId)) throw rejection('badAudience');
        if (typeof payload.exp !== 'number' || payload.exp <= now - skew)
            throw rejection('expired');
        if (typeof payload.iat !== 'number' || payload.iat < now - 600) throw rejection('tooOld');
        if (payload.nonce !== input.expectedNonce) throw rejection('badNonce');
        const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : null;
        if (
            input.maxAuthAgeSeconds !== undefined &&
            (authTime === null || authTime < now - input.maxAuthAgeSeconds - skew)
        ) {
            throw rejection('tooOld');
        }
        const hints = Object.fromEntries(
            Object.entries(payload).filter(([key]) => key.startsWith('urn:ever:')),
        );
        const claims: VerifiedIdTokenClaims = {
            issuer: String(payload.iss),
            subject: String(payload.sub),
            email: typeof payload.email === 'string' && payload.email ? payload.email : null,
            emailVerified: payload.email_verified === true,
            name: typeof payload.name === 'string' && payload.name ? payload.name : null,
            authTime,
            sid: typeof payload.sid === 'string' && payload.sid ? payload.sid : null,
        };
        if (Object.keys(hints).length > 0) claims.hints = hints;
        return claims;
    }

    async verifyAccessToken(
        token: string,
        input: {
            requiredScopes: string[];
            maxLifetimeSeconds: number;
            maxAgeSeconds?: number;
            allowedAuthorizedParties?: string[];
        },
    ): Promise<VerifiedAccessTokenClaims> {
        const settings = this.configured();
        const document = await this.discovery();
        const payload = await this.verifyJws(token, document);
        const now = Math.floor(Date.now() / 1000);
        const skew = settings.clockSkewSeconds ?? 60;
        if (payload.iss !== settings.issuerUrl) throw rejection('badIssuer');
        const audiences = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]) as string[];
        if (!audiences.includes(settings.apiAudience ?? 'ever-works'))
            throw rejection('badAudience');
        const scopes =
            typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
        if (input.requiredScopes.some((scope) => !scopes.includes(scope)))
            throw rejection('missingScope');
        const iat = Number(payload.iat);
        const exp = Number(payload.exp);
        if (!(exp > now - skew)) throw rejection('expired');
        if (exp - iat > input.maxLifetimeSeconds) throw rejection('lifetimeTooLong');
        if (input.maxAgeSeconds !== undefined && iat < now - input.maxAgeSeconds)
            throw rejection('tooOld');
        const azp = typeof payload.azp === 'string' ? payload.azp : null;
        if (
            input.allowedAuthorizedParties &&
            (!azp || !input.allowedAuthorizedParties.includes(azp))
        ) {
            throw rejection('badAuthorizedParty');
        }
        return {
            issuer: String(payload.iss),
            subject: String(payload.sub),
            audience: audiences,
            scopes,
            authorizedParty: azp,
            issuedAt: iat,
            expiresAt: exp,
            jti: typeof payload.jti === 'string' ? payload.jti : null,
        };
    }

    async verifyLogoutToken(token: string): Promise<VerifiedLogoutTokenClaims> {
        const settings = this.configured();
        const document = await this.discovery();
        const payload = await this.verifyJws(token, document);
        const now = Math.floor(Date.now() / 1000);
        if (payload.iss !== settings.issuerUrl) throw rejection('badIssuer');
        const events = payload.events as Record<string, unknown> | undefined;
        if (!events || !('http://schemas.openid.net/event/backchannel-logout' in events)) {
            throw rejection('badLogoutEvent');
        }
        if ('nonce' in payload) throw rejection('nonceInLogoutToken');
        if (typeof payload.iat !== 'number' || payload.iat < now - 300) throw rejection('tooOld');
        const sid = typeof payload.sid === 'string' ? payload.sid : null;
        const sub = typeof payload.sub === 'string' ? payload.sub : null;
        if (!sid && !sub) throw rejection('badLogoutEvent');
        if (typeof payload.jti !== 'string') throw rejection('badLogoutEvent');
        return { issuer: String(payload.iss), subject: sub, sid, jti: payload.jti };
    }

    async buildEndSessionUrl(input: {
        postLogoutRedirectUri: string;
        state: string;
    }): Promise<string | null> {
        const { clientId } = this.configured();
        const document = await this.discovery();
        if (typeof document.end_session_endpoint !== 'string') return null;
        const url = new URL(document.end_session_endpoint);
        url.searchParams.set('client_id', clientId);
        url.searchParams.set('post_logout_redirect_uri', input.postLogoutRedirectUri);
        url.searchParams.set('state', input.state);
        return url.toString();
    }

    private async verifyJws(
        token: string,
        document: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        const parts = token.split('.');
        if (parts.length !== 3) throw rejection('badSignature');
        const header = decodePart(parts[0]);
        if (header.alg !== 'ES256') throw rejection('badAlg');
        const response = await fetch(String(document.jwks_uri));
        const { keys } = (await response.json()) as { keys: Array<Record<string, unknown>> };
        const jwk = keys.find((key) => key.kid === header.kid);
        if (!jwk) throw rejection('badSignature');
        const ok = verify(
            'sha256',
            Buffer.from(`${parts[0]}.${parts[1]}`),
            {
                key: createPublicKey({ key: jwk as never, format: 'jwk' }),
                dsaEncoding: 'ieee-p1363',
            },
            Buffer.from(parts[2], 'base64url'),
        );
        if (!ok) throw rejection('badSignature');
        return decodePart(parts[1]);
    }
}

/** A controller marked for the delegated read, and one that is not (FR-46). */
@Controller('api/test-delegated')
export class DelegatedProbeController {
    @Get('marked')
    @DelegatedRead('apps:read')
    marked(@Request() req) {
        return { userId: req.user?.userId, authMethod: req.user?.authMethod };
    }

    @Get('unmarked')
    unmarked(@Request() req) {
        return { userId: req.user?.userId, authMethod: req.user?.authMethod };
    }
}

export interface EverIdHarness {
    app: INestApplication;
    dataSource: DataSource;
    fake: FakeOidcProvider | null;
    facade: IdentityProviderFacadeService;
    settings: TestProviderSettings;
    activityRows: Array<Record<string, unknown>>;
    telemetry: Array<{ distinctId: string; event: string; properties: Record<string, unknown> }>;
    pluginSettingsRow: () => Record<string, unknown>;
    setEnabled(enabled: boolean): Promise<void>;
    createUser(input: {
        email: string;
        username?: string;
        emailVerified?: boolean;
        isActive?: boolean;
        isPlatformAdmin?: boolean;
    }): Promise<User>;
    /** A real Ever Works session (the same token shape every sign-in returns). */
    sessionFor(
        userId: string,
        origin?: { externalIdentityId: string; externalSid?: string | null },
    ): Promise<string>;
    close(): Promise<void>;
}

/**
 * Boot the harness. `withFakeProvider: false` points the configuration at a host
 * that must never be contacted (the "switched off" egress proof) instead of
 * starting the fake provider.
 */
export async function createEverIdHarness(
    options: {
        enabled?: boolean;
        withFakeProvider?: boolean;
        issuerUrl?: string;
        settings?: Partial<TestProviderSettings>;
        /**
         * Controllers and providers of another surface, mounted next to the Ever ID ones so a
         * spec can drive its own delegated-read handler through the real guard (the App
         * Launcher's `GET /api/me/apps`, for one).
         */
        controllers?: Type<unknown>[];
        providers?: Provider[];
        /** Runs on the application before `init()`, for example to mount a middleware. */
        configureApp?: (app: INestApplication) => void;
    } = {},
): Promise<EverIdHarness> {
    process.env.AUTH_SECRET = TEST_AUTH_SECRET;
    process.env.WEB_URL = TEST_WEB_URL;

    const fake =
        options.withFakeProvider === false
            ? null
            : await FakeOidcProvider.start({
                  clientId: 'ever-works-web',
                  clientSecret: 'fake-client-secret',
                  localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }],
              });
    const settings: TestProviderSettings = {
        issuerUrl: fake?.issuer ?? options.issuerUrl,
        clientId: 'ever-works-web',
        clientSecret: 'fake-client-secret',
        apiAudience: 'ever-works',
        localClients: [{ kind: 'cli', clientId: 'ever-works-cli' }],
        delegatedClientNames: [{ clientId: 'ever-works-web', displayName: 'Ever apps' }],
        accountManagementUrl: 'https://id.example.test/account',
        ...(options.settings ?? {}),
    };

    const dataSource = new DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: ENTITIES,
        synchronize: true,
        logging: false,
    });
    await dataSource.initialize();

    const events = new EventEmitter2();
    const registry = new PluginRegistryService(events);
    const plugin = new TestIdentityProviderPlugin(() => settings);
    registry.register(
        plugin as never,
        {
            id: plugin.id,
            name: plugin.name,
            version: plugin.version,
            category: 'identity',
            capabilities: ['identity-provider'],
        } as never,
        { state: 'loaded', builtIn: true },
    );
    let pluginRow: Record<string, unknown> = options.enabled ? { enabled: true } : {};
    const pluginRepository = {
        findByPluginId: async () => ({ settings: pluginRow }),
        updateSettings: async (_id: string, next: Record<string, unknown>) => {
            pluginRow = next;
            return { settings: pluginRow };
        },
    };
    const settingsService = {
        // The platform's settings service refuses writes to environment-bound
        // fields; the four administrator-managed ones land in the settings.
        updateAdminSettings: async (_pluginId: string, patch: Record<string, unknown>) => {
            Object.assign(settings, patch);
        },
        getResolvedSettings: async () =>
            Object.fromEntries(
                Object.entries(settings).map(([key, value]) => [
                    key,
                    { key, value, source: 'env', isFallback: true },
                ]),
            ),
    };
    const facade = new IdentityProviderFacadeService(
        registry,
        pluginRepository as never,
        settingsService as never,
    );

    const users = new UserRepository(dataSource.getRepository(User));
    const identities = new ExternalIdentityRepository(dataSource.getRepository(ExternalIdentity));
    const organizations = new OrganizationRepository(dataSource.getRepository(Organization));
    const activityRows: Array<Record<string, unknown>> = [];
    const activityLog = {
        log: async (row: Record<string, unknown>) => {
            activityRows.push(row);
            return row;
        },
    };
    const telemetry: EverIdHarness['telemetry'] = [];
    const analytics = {
        track: (distinctId: string, event: string, properties: Record<string, unknown>) => {
            telemetry.push({ distinctId, event, properties });
        },
    };
    const terms = {
        assertClaimsArePublished: () => undefined,
        getRequiredDocuments: () =>
            TERMS.map(({ documentId, version, sha256, locale }) => ({
                documentId,
                version,
                sha256,
                locale,
            })),
        record: async () => [],
    };
    const authRuntimeStub = {};
    const authSyncStub = {};
    const authProvider = new AuthProviderService(
        authRuntimeStub as never,
        users,
        authSyncStub as never,
        dataSource,
    );

    const seal = new EverIdSealService();
    const replay = new EverIdReplayService(dataSource);
    const sessions = new EverIdSessionService(dataSource, replay);
    const activity = new EverIdActivityService(activityLog as never);
    const telemetryService = new EverIdTelemetryService(analytics as never);
    const claimHints = new EverIdClaimHintsService(dataSource);
    const usernames = new UsernameAllocatorService(users, organizations);
    const linking = new EverIdLinkingService(
        identities,
        users,
        facade,
        seal,
        replay,
        sessions,
        activity,
        telemetryService,
        claimHints,
        terms as never,
        usernames,
        events,
        authProvider,
        dataSource,
    );
    const signIn = new EverIdSignInService(
        facade,
        seal,
        replay,
        sessions,
        linking,
        identities,
        users,
        activity,
        telemetryService,
        authProvider,
    );
    const backchannel = new EverIdBackchannelService(
        facade,
        identities,
        replay,
        sessions,
        activity,
        telemetryService,
        dataSource,
    );
    const delegation = new EverIdDelegationService(
        facade,
        identities,
        users,
        activity,
        telemetryService,
    );
    const apiKeys = {
        validateKey: async (key: string) =>
            key === TEST_API_KEY ? { userId: apiKeyOwner.id } : null,
    };
    const apiKeyOwner: { id: string } = { id: '' };

    const moduleRef = await Test.createTestingModule({
        controllers: [EverIdController, DelegatedProbeController, ...(options.controllers ?? [])],
        providers: [
            { provide: EverIdSignInService, useValue: signIn },
            { provide: EverIdLinkingService, useValue: linking },
            { provide: EverIdSessionService, useValue: sessions },
            { provide: EverIdBackchannelService, useValue: backchannel },
            { provide: IdentityProviderFacadeService, useValue: facade },
            { provide: EverIdActivityService, useValue: activity },
            { provide: UserRepository, useValue: users },
            { provide: ApiKeyService, useValue: apiKeys },
            { provide: AUTH_PROVIDER, useValue: authProvider },
            { provide: EVER_ID_DELEGATION_VERIFIER, useValue: delegation },
            { provide: EVER_ID_SIGNED_OUT_PROBE, useValue: sessions },
            EverIdAdminGuard,
            { provide: APP_GUARD, useClass: AuthSessionGuard },
            ...(options.providers ?? []),
        ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(
        new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    options.configureApp?.(app);
    await app.init();

    let userCounter = 0;
    const harness: EverIdHarness = {
        app,
        dataSource,
        fake,
        facade,
        settings,
        activityRows,
        telemetry,
        pluginSettingsRow: () => pluginRow,
        async setEnabled(enabled: boolean) {
            await facade.setEnabled(enabled);
        },
        async createUser(input) {
            userCounter += 1;
            const username = input.username ?? `person-${userCounter}`;
            const user = await dataSource.getRepository(User).save(
                dataSource.getRepository(User).create({
                    username,
                    slug: username,
                    email: input.email,
                    password: 'not-a-real-hash',
                    registrationProvider: 'local',
                    emailVerified: input.emailVerified ?? true,
                    isActive: input.isActive ?? true,
                    isPlatformAdmin: input.isPlatformAdmin ?? false,
                }),
            );
            if (!apiKeyOwner.id) apiKeyOwner.id = user.id;
            return user;
        },
        async sessionFor(userId, origin) {
            const response = await authProvider.issueSession(userId, undefined, origin);
            return response.access_token;
        },
        async close() {
            await app.close();
            await dataSource.destroy();
            await fake?.stop();
        },
    };
    return harness;
}

/**
 * Drive a browser sign-in end to end the way the web does: `POST /authorize`,
 * follow the provider's auto-approving authorize redirect, then `POST /callback`
 * with the code, state and issuer the provider returned.
 */
export async function completeBrowserSignIn(
    harness: EverIdHarness,
    options: { bearer?: string; returnTo?: string; intent?: 'sign-in' | 'connect' } = {},
): Promise<{ status: number; body: Record<string, unknown>; authorizationUrl: string }> {
    const server = harness.app.getHttpServer();
    const start =
        options.intent === 'connect'
            ? await request(server)
                  .post('/api/auth/ever-id/connect/authorize')
                  .set('Authorization', `Bearer ${options.bearer}`)
                  .send({})
            : await request(server)
                  .post('/api/auth/ever-id/authorize')
                  .send(options.returnTo ? { returnTo: options.returnTo } : {});
    if (start.status !== 200) {
        return { status: start.status, body: start.body, authorizationUrl: '' };
    }
    const { authorizationUrl, transaction } = start.body as {
        authorizationUrl: string;
        transaction: string;
    };
    const redirect = await fetch(authorizationUrl, { redirect: 'manual' });
    const location = new URL(String(redirect.headers.get('location')));
    let callback = request(server).post('/api/auth/ever-id/callback');
    if (options.bearer) callback = callback.set('Authorization', `Bearer ${options.bearer}`);
    const done = await callback.send({
        code: location.searchParams.get('code'),
        state: location.searchParams.get('state'),
        iss: location.searchParams.get('iss') ?? undefined,
        transaction,
    });
    return { status: done.status, body: done.body, authorizationUrl };
}
