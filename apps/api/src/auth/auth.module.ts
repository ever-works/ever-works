import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthService } from './services/auth.service';
import { AuthController } from './controllers/auth.controller';
import { OAuthController } from './controllers/oauth.controller';
import { GithubAuthStrategy } from './strategies/github.strategy';
import { GoogleAuthStrategy } from './strategies/google.strategy';
import { TokenCleanupService } from './tasks/token-cleanup.service';
import { OAuthUrlService } from './services/oauth-url.service';
import {
    DatabaseModule,
    UserRepository,
    RefreshTokenRepository,
    OAuthTokenRepository,
} from '@ever-works/agent/database';
import { jwtConstants } from '../config/constants';

@Module({
    imports: [
        PassportModule,
        DatabaseModule,
        ScheduleModule.forRoot(),
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
        LocalStrategy,
        JwtStrategy,
        GithubAuthStrategy,
        GoogleAuthStrategy,
        UserRepository,
        RefreshTokenRepository,
        OAuthTokenRepository,
        TokenCleanupService,
        OAuthUrlService,
    ],
    controllers: [OAuthController, AuthController],
    exports: [AuthService],
})
export class AuthModule {}
