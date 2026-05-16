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
import { AuthSessionGuard } from './guards/auth-session.guard';
import { DataSource } from 'typeorm';
import {
    DatabaseModule,
    ApiKeyRepository,
    UserRepository,
    AuthAccountRepository,
} from '@ever-works/agent/database';
import { ActivityLogModule } from '@ever-works/agent/activity-log';

@Module({
    imports: [DatabaseModule, HttpModule, ActivityLogModule],
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
    ],
    controllers: [OAuthController, AuthController, ApiKeysController],
    exports: [
        AuthService,
        AnonymousAuthService,
        ClaimAccountService,
        ApiKeyService,
        CaptchaVerifierService,
        AuthSessionGuard,
        AUTH_PROVIDER,
        AUTH_RUNTIME_INSTANCE,
        AuthSyncService,
    ],
})
export class AuthModule {}
