import { Module } from '@nestjs/common';
import {
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
} from '@ever-works/agent/facades';
import { OAuthTokenRepository } from '@ever-works/agent/database';
import { TriggerInternalModule } from '../trigger-internal.module';
import { TriggerInternalApiClient } from '../trigger-internal-api.client';
import { createRemoteProxy } from './remote-proxy';

const FACADES = [
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
];

/**
 * Facades module for Trigger.dev context.
 * OAuthTokenRepository is proxied to the API; `isTokenExpired` runs locally (sync).
 */
@Module({
    imports: [TriggerInternalModule],
    providers: [
        ...FACADES,
        {
            provide: OAuthTokenRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'OAuthTokenRepository', {
                    isTokenExpired(token: { expiresAt?: Date | string | null }) {
                        if (!token.expiresAt) return false;
                        return new Date() > new Date(token.expiresAt);
                    },
                }),
            inject: [TriggerInternalApiClient],
        },
    ],
    exports: FACADES,
})
export class TriggerFacadesModule {}
