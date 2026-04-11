import { Module } from '@nestjs/common';
import {
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    PromptFacadeService,
} from '@ever-works/agent/facades';
import { AuthAccountRepository } from '@ever-works/agent/database';
import { TriggerInternalModule } from './trigger-internal.module';
import { TriggerInternalApiClient } from '../services/trigger-internal-api.client';
import { createRemoteProxy } from '../remote-proxy';

const FACADES = [
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    PromptFacadeService,
];

/**
 * Facades module for Trigger.dev context.
 * AuthAccountRepository is proxied to the API; `isAccessTokenExpired` runs locally (sync).
 */
@Module({
    imports: [TriggerInternalModule],
    providers: [
        ...FACADES,
        {
            provide: AuthAccountRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'AuthAccountRepository', {
                    isAccessTokenExpired(account: { accessTokenExpiresAt?: Date | string | null }) {
                        if (!account.accessTokenExpiresAt) return false;
                        return new Date() > new Date(account.accessTokenExpiresAt);
                    },
                }),
            inject: [TriggerInternalApiClient],
        },
    ],
    exports: FACADES,
})
export class TriggerFacadesModule {}
