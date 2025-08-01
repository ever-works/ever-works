import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';
import { LocalStrategy } from './strategies/local.strategy';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthService } from './services/auth.service';
import { AuthController } from './controllers/auth.controller';
import { OAuthConnectionsController } from './controllers/oauth-connections.controller';
import { GithubAuthStrategy } from './strategies/github.strategy';
import { GoogleAuthStrategy } from './strategies/google.strategy';
import { GithubConnectStrategy } from './strategies/github-connect.strategy';
import { TokenCleanupService } from './tasks/token-cleanup.service';
import { OAuthTokenService } from './services/oauth-token.service';
import { OAuthConnectionService } from './services/oauth-connection.service';
import { GitHubTokenService } from './services/github-token.service';
import {
    DatabaseModule,
    UserRepository,
    RefreshTokenRepository,
    OAuthTokenRepository,
} from '@packages/agent/database';
import { jwtConstants } from '@src/config/constants';

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
        GithubConnectStrategy,
        UserRepository,
        RefreshTokenRepository,
        OAuthTokenRepository,
        TokenCleanupService,
        OAuthTokenService,
        OAuthConnectionService,
        GitHubTokenService,
    ],
    controllers: [AuthController, OAuthConnectionsController],
    exports: [AuthService, OAuthTokenService, OAuthConnectionService, GitHubTokenService],
})
export class AuthModule {}
