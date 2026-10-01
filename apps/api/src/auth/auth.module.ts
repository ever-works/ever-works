import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthService } from './services/auth.service';
import { AnonymousAuthService } from './services/anonymous-auth.service';
import { ClaimAccountService } from './services/claim-account.service';
import { ApiKeyService } from './services/api-key.service';
import { CAPTCHA_FETCH, CaptchaVerifierService } from './services/captcha-verifier.service';
import { ZeroFrictionFunnelService } from '@ever-works/agent/services';
import { AuthController } from './controllers/auth.controller';
import { ApiKeysController } from './controllers/api-keys.controller';
import { OAuthController } from './controllers/oauth.controller';
import { AUTH_PROVIDER, AUTH_RUNTIME_INSTANCE } from './providers/auth-provider.constants';
import { AuthProviderService } from './providers/auth-provider.service';
import { AuthSyncService } from './providers/auth-sync.service';
import { createAuthRuntimeInstance } from './providers/auth-runtime.instance';
import { SocialAuthService } from './services/social-auth.service';
import { OAuthStateService } from './services/oauth-state.service';
import { AuthSessionGuard } from './guards/auth-session.guard';
import { TermsAcceptanceService } from '../terms/terms-acceptance.service';
import { TermsController } from '../terms/terms.controller';
import { DataSource } from 'typeorm';
import {
    DatabaseModule,
    ApiKeyRepository,
    UserRepository,
    AuthAccountRepository,
} from '@ever-works/agent/database';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import { FacadesModule } from '@ever-works/agent/facades';
import { EverIdAdminGuard, EverIdController } from './controllers/ever-id.controller';
import {
    EVER_ID_DELEGATION_VERIFIER,
    EVER_ID_SIGNED_OUT_PROBE,
} from './guards/ever-id-guard.tokens';
import { NoTokenInQueryGuard } from './guards/no-token-in-query.guard';
import { SessionOnlyGuard } from './guards/session-only.guard';
import { EverIdProvidersInterceptor } from './interceptors/ever-id-providers.interceptor';
import { EverIdActivityService } from './services/ever-id-activity.service';
import { EverIdBackchannelService } from './services/ever-id-backchannel.service';
import { EverIdClaimHintsService } from './services/ever-id-claims-hints';
import { EverIdDelegationService } from './services/ever-id-delegation.service';
import { EverIdLinkingService } from './services/ever-id-linking.service';
import { EverIdReplayService } from './services/ever-id-replay.service';
import { EverIdSealService } from './services/ever-id-seal.service';
import { EverIdSessionService } from './services/ever-id-session.service';
import { EverIdSignInService } from './services/ever-id-sign-in.service';
import { EverIdTelemetryService } from './services/ever-id-telemetry.service';
import { UsernameAllocatorService } from '../users/services/username-allocator.service';

@Module({
    // APW-12 (Ever ID) — `FacadesModule` is the one addition here: it provides the
    // identity provider facade the Ever ID services resolve the plugin through
    // (the same import `plugins-capabilities/oauth/oauth.module.ts` makes).
    imports: [DatabaseModule, HttpModule, ActivityLogModule, FacadesModule],
    providers: [
        AuthService,
        AnonymousAuthService,
        ClaimAccountService,
        ApiKeyService,
        {
            provide: CAPTCHA_FETCH,
            useFactory: () => fetch,
        },
        CaptchaVerifierService,
        // EW-617 G8: registered here (not imported from WorkModule) to keep
        // AuthModule free of a WorkModule dependency. The service is stateless
        // (a logger wrapper), so the duplicate instance is harmless. The
        // ZERO_FRICTION_FUNNEL_ANALYTICS DI token (→ PostHog) is bound
        // globally by FunnelAnalyticsBindingModule at the app root.
        ZeroFrictionFunnelService,
        AuthProviderService,
        AuthSyncService,
        SocialAuthService,
        OAuthStateService,
        AuthSessionGuard,
        ApiKeyRepository,
        UserRepository,
        AuthAccountRepository,
        {
            provide: AUTH_PROVIDER,
            useExisting: AuthProviderService,
        },
        {
            provide: AUTH_RUNTIME_INSTANCE,
            inject: [DataSource],
            useFactory: (dataSource: DataSource) => createAuthRuntimeInstance(dataSource),
        },
        // Lives here rather than in its own module because it depends on the
        // AUTH_RUNTIME_INSTANCE token and AuthController depends on it in turn;
        // a separate module would be a cycle for no gain.
        TermsAcceptanceService,
        // APW-12 (Ever ID) — additive: the relying-party services, guards and the
        // providers-field interceptor. `UsernameAllocatorService` is registered
        // here (stateless, DatabaseModule repositories only) to keep AuthModule
        // free of a UsersModule dependency, like `ZeroFrictionFunnelService` above.
        EverIdSealService,
        EverIdReplayService,
        EverIdSessionService,
        EverIdActivityService,
        EverIdTelemetryService,
        EverIdClaimHintsService,
        EverIdLinkingService,
        EverIdSignInService,
        EverIdBackchannelService,
        EverIdDelegationService,
        EverIdAdminGuard,
        EverIdProvidersInterceptor,
        NoTokenInQueryGuard,
        SessionOnlyGuard,
        UsernameAllocatorService,
        // The two collaborators the global `AuthSessionGuard` reaches for lazily
        // on the Ever ID paths (delegated read, "signed out by Ever ID").
        { provide: EVER_ID_DELEGATION_VERIFIER, useExisting: EverIdDelegationService },
        { provide: EVER_ID_SIGNED_OUT_PROBE, useExisting: EverIdSessionService },
    ],
    controllers: [
        OAuthController,
        AuthController,
        ApiKeysController,
        TermsController,
        // APW-12 (Ever ID) — `/api/auth/ever-id/*`.
        EverIdController,
    ],
    exports: [
        AuthService,
        AnonymousAuthService,
        ClaimAccountService,
        ApiKeyService,
        CaptchaVerifierService,
        OAuthStateService,
        AuthSessionGuard,
        AUTH_PROVIDER,
        AUTH_RUNTIME_INSTANCE,
        AuthSyncService,
        TermsAcceptanceService,
        // APW-12 (Ever ID) — ends the sessions an identity opened (needed by any
        // later module that removes identities), and the two guard collaborators.
        EverIdSessionService,
        EVER_ID_DELEGATION_VERIFIER,
        EVER_ID_SIGNED_OUT_PROBE,
    ],
})
export class AuthModule {}
