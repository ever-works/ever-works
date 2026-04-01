import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { HttpModule } from '@nestjs/axios';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthService } from './services/auth.service';
import { ApiKeyService } from './services/api-key.service';
import { AuthController } from './controllers/auth.controller';
import { ApiKeysController } from './controllers/api-keys.controller';
import { OAuthController } from './controllers/oauth.controller';
import { GithubAuthStrategy } from './strategies/github.strategy';
import { GoogleAuthStrategy } from './strategies/google.strategy';
import { TokenCleanupService } from './tasks/token-cleanup.service';
import { OAuthUrlService } from './services/oauth-url.service';
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
    ],
    controllers: [OAuthController, AuthController, ApiKeysController],
    exports: [AuthService, ApiKeyService],
})
export class AuthModule {}
