import { Module } from '@nestjs/common';
import {
    AiFacadeService,
    SearchFacadeService,
    ScreenshotFacadeService,
    ContentExtractorFacadeService,
    DataSourceFacadeService,
    GitFacadeService,
    PromptFacadeService,
    CodeEditFacadeService,
} from '@ever-works/agent/facades';
import {
    AuthAccountRepository,
    WorkRepository,
    GitHubAppInstallationRepository,
} from '@ever-works/agent/database';
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
    CodeEditFacadeService,
];

/**
 * Facades module for Trigger.dev context.
 *
 * Repositories that the facades depend on are proxied to the API
 * (`createRemoteProxy`). `AuthAccountRepository.isAccessTokenExpired`
 * runs locally because it has no DB side and is called in hot paths.
 *
 * `WorkRepository` and `GitHubAppInstallationRepository` are required by
 * `GitFacadeService` (`findById` + `findByInstallationId` for GitHub App
 * installation token lookups). They must be provided IN THIS module so
 * the DI container can resolve them when GitFacadeService is instantiated
 * here — providing them only in the outer `TriggerWorkerModule` doesn't
 * satisfy the scope.
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
        {
            provide: WorkRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'WorkRepository'),
            inject: [TriggerInternalApiClient],
        },
        {
            provide: GitHubAppInstallationRepository,
            useFactory: (apiClient: TriggerInternalApiClient) =>
                createRemoteProxy(apiClient, 'GitHubAppInstallationRepository'),
            inject: [TriggerInternalApiClient],
        },
    ],
    exports: FACADES,
})
export class TriggerFacadesModule {}
