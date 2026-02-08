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
 *
 * Provides facade services used by the generation/import pipeline but without
 * DatabaseModule (which requires a TypeORM connection unavailable in Trigger.dev).
 *
 * OAuthFacadeService and DeployFacadeService are excluded because they are not
 * used in the Trigger pipeline and have additional TypeORM dependencies
 * (DirectoryRepository) that cannot be easily stubbed.
 *
 * GitFacadeService needs OAuthTokenRepository for credential lookup; a remote
 * proxy is used so that method calls are forwarded to the API over HTTP.
 * The `isTokenExpired` method is provided locally because it is called
 * synchronously and only contains pure date-comparison logic.
 *
 * All other facade dependencies (PluginRegistryService, PluginSettingsService,
 * DirectoryPluginRepository) are provided by the global TriggerPluginsModule.
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
