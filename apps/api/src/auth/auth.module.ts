import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { HttpModule } from '@nestjs/axios';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthService } from './services/auth.service';
import { ApiKeyService } from './services/api-key.service';
import { BetterAuthService } from './services/better-auth.service';
import { AuthController } from './controllers/auth.controller';
import { ApiKeysController } from './controllers/api-keys.controller';
import { OAuthController } from './controllers/oauth.controller';
import { BetterAuthController } from './controllers/better-auth.controller';
import { GithubAuthStrategy } from './strategies/github.strategy';
import { GoogleAuthStrategy } from './strategies/google.strategy';
import { TokenCleanupService } from './tasks/token-cleanup.service';
import { OAuthUrlService } from './services/oauth-url.service';
import { SessionAuthGuard } from './guards/session-auth.guard';
import {
    DatabaseModule,
    ApiKeyRepository,
    UserRepository,
    RefreshTokenRepository,
    OAuthTokenRepository,
} from '@ever-works/agent/database';
import { jwtConstants } from '../config/constants';

@Module({
    imports: [
        PassportModule,
        DatabaseModule,
        HttpModule,
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
        BetterAuthService,
        LocalStrategy,
        JwtStrategy,
        GithubAuthStrategy,
        GoogleAuthStrategy,
        ApiKeyRepository,
        UserRepository,
        RefreshTokenRepository,
        OAuthTokenRepository,
        TokenCleanupService,
        OAuthUrlService,
        SessionAuthGuard,
    ],
    controllers: [OAuthController, AuthController, ApiKeysController, BetterAuthController],
    exports: [AuthService, ApiKeyService, BetterAuthService, SessionAuthGuard],
})
export class AuthModule {}
