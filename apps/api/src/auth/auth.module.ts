import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { HttpModule } from '@nestjs/axios';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthService } from './services/auth.service';
import { ApiKeyService } from './services/api-key.service';
import { AuthController } from './controllers/auth.controller';
import { ApiKeysController } from './controllers/api-keys.controller';
import { OAuthController } from './controllers/oauth.controller';
import { TokenCleanupService } from './tasks/token-cleanup.service';
import { AUTH_PROVIDER, AUTH_RUNTIME_INSTANCE } from './providers/auth-provider.constants';
import { AuthProviderService } from './providers/auth-provider.service';
import { AuthSyncService } from './providers/auth-sync.service';
import { createAuthRuntimeInstance } from './providers/auth-runtime.instance';
import { SocialAuthService } from './services/social-auth.service';
import {
    DatabaseModule,
    ApiKeyRepository,
    UserRepository,
    RefreshTokenRepository,
    OAuthTokenRepository,
} from '@ever-works/agent/database';
import { jwtConstants } from '../config/constants';
import { ActivityLogModule } from '@ever-works/agent/activity-log';

@Module({
    imports: [
        PassportModule,
        DatabaseModule,
        HttpModule,
        ActivityLogModule,
        JwtModule.registerAsync({
            useFactory: () => ({
                secret: jwtConstants.secret(),
                signOptions: { expiresIn: jwtConstants.accessTokenExpiration() },
            }),
        }),
    ],
    providers: [
        AuthService,
        ApiKeyService,
        AuthProviderService,
        AuthSyncService,
        SocialAuthService,
        JwtStrategy,
        ApiKeyRepository,
        UserRepository,
        RefreshTokenRepository,
        OAuthTokenRepository,
        TokenCleanupService,
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
    exports: [AuthService, ApiKeyService, AUTH_PROVIDER, AUTH_RUNTIME_INSTANCE, AuthSyncService],
})
export class AuthModule {}
