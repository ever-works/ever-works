import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthService } from './services/auth.service';
import { ApiKeyService } from './services/api-key.service';
import { BetterAuthService } from './services/better-auth.service';
import { AuthController } from './controllers/auth.controller';
import { ApiKeysController } from './controllers/api-keys.controller';
import { BetterAuthController } from './controllers/better-auth.controller';
import { SessionAuthGuard } from './guards/session-auth.guard';
import {
    DatabaseModule,
    ApiKeyRepository,
    UserRepository,
    OAuthTokenRepository,
} from '@ever-works/agent/database';

@Module({
    imports: [DatabaseModule, HttpModule],
    providers: [
        AuthService,
        ApiKeyService,
        BetterAuthService,
        ApiKeyRepository,
        UserRepository,
        OAuthTokenRepository,
        SessionAuthGuard,
    ],
    controllers: [AuthController, ApiKeysController, BetterAuthController],
    exports: [AuthService, ApiKeyService, BetterAuthService, SessionAuthGuard],
})
export class AuthModule {}
