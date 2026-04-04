import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthService } from './services/auth.service';
import { ApiKeyService } from './services/api-key.service';
import { AuthController } from './controllers/auth.controller';
import { ApiKeysController } from './controllers/api-keys.controller';
import { OAuthController } from './controllers/oauth.controller';
import { AUTH_PROVIDER, AUTH_RUNTIME_INSTANCE } from './providers/auth-provider.constants';
import { AuthProviderService } from './providers/auth-provider.service';
import { AuthSyncService } from './providers/auth-sync.service';
import { createAuthRuntimeInstance } from './providers/auth-runtime.instance';
import { SocialAuthService } from './services/social-auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
    DatabaseModule,
    ApiKeyRepository,
    UserRepository,
    OAuthTokenRepository,
} from '@ever-works/agent/database';
import { ActivityLogModule } from '@ever-works/agent/activity-log';

@Module({
    imports: [DatabaseModule, HttpModule, ActivityLogModule],
    providers: [
        AuthService,
        ApiKeyService,
        AuthProviderService,
        AuthSyncService,
        SocialAuthService,
        JwtAuthGuard,
        ApiKeyRepository,
        UserRepository,
        OAuthTokenRepository,
        {
            provide: AUTH_PROVIDER,
            useExisting: AuthProviderService,
        },
        {
            provide: AUTH_RUNTIME_INSTANCE,
            useFactory: createAuthRuntimeInstance,
        },
    ],
    controllers: [OAuthController, AuthController, ApiKeysController],
    exports: [
        AuthService,
        ApiKeyService,
        JwtAuthGuard,
        AUTH_PROVIDER,
        AUTH_RUNTIME_INSTANCE,
        AuthSyncService,
    ],
})
export class AuthModule {}
