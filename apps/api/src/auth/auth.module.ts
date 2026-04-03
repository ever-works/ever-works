import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { AuthService } from './services/auth.service';
import { ApiKeyService } from './services/api-key.service';
import { AuthProviderService } from './services/auth-provider.service';
import { AuthController } from './controllers/auth.controller';
import { ApiKeysController } from './controllers/api-keys.controller';
import { AuthProviderController } from './controllers/auth-provider.controller';
import { SessionAuthGuard } from './guards/session-auth.guard';
import { ActivityLogModule } from '@ever-works/agent/activity-log';
import {
    DatabaseModule,
    ApiKeyRepository,
    UserRepository,
    OAuthTokenRepository,
} from '@ever-works/agent/database';

@Module({
    imports: [DatabaseModule, HttpModule, ActivityLogModule],
    providers: [
        AuthService,
        ApiKeyService,
        AuthProviderService,
        ApiKeyRepository,
        UserRepository,
        OAuthTokenRepository,
        SessionAuthGuard,
    ],
    controllers: [AuthController, ApiKeysController, AuthProviderController],
    exports: [AuthService, ApiKeyService, AuthProviderService, SessionAuthGuard],
})
export class AuthModule {}
