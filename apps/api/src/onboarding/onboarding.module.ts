import { Module } from '@nestjs/common';
import {
    ONBOARDING_ACCOUNT_UPSERT,
    ONBOARDING_GIT_PROVIDER,
    ONBOARDING_WORK_CREATOR,
    OnboardingRequestRepository,
    FetchWebhookHttpClient,
    WebhookDeliveryService,
    WebhookSubscriptionRepository,
    WEBHOOK_HTTP_CLIENT,
    WorksManifestService,
} from '@ever-works/agent/onboarding';
import { FacadesModule, GitFacadeService } from '@ever-works/agent/facades';
import { DatabaseModule } from '@ever-works/agent/database';
import { WorkModule } from '@ever-works/agent/services';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OnboardingTerminalService } from './onboarding-terminal.service';
import { OnboardingAccountAdapter } from './onboarding-account.adapter';
import { OnboardingWorkAdapter } from './onboarding-work.adapter';
import { WellKnownController } from './well-known.controller';
import { ClaimController } from './claim.controller';
import { AuthModule } from '../auth';

@Module({
    imports: [FacadesModule, DatabaseModule, WorkModule, AuthModule],
    controllers: [OnboardingController, WellKnownController, ClaimController],
    providers: [
        OnboardingService,
        OnboardingTerminalService,
        OnboardingAccountAdapter,
        OnboardingWorkAdapter,
        WorksManifestService,
        FetchWebhookHttpClient,
        WebhookDeliveryService,
        OnboardingRequestRepository,
        WebhookSubscriptionRepository,
        {
            provide: WEBHOOK_HTTP_CLIENT,
            useExisting: FetchWebhookHttpClient,
        },
        {
            provide: ONBOARDING_GIT_PROVIDER,
            useExisting: GitFacadeService,
        },
        {
            provide: ONBOARDING_ACCOUNT_UPSERT,
            useExisting: OnboardingAccountAdapter,
        },
        {
            provide: ONBOARDING_WORK_CREATOR,
            useExisting: OnboardingWorkAdapter,
        },
        // StateMarkerService needs a MarkerFileWriter implementation that holds
        // the per-work GitHub credential. That wiring lands with T9d. For now
        // OnboardingTerminalService declares the dep as @Optional() and skips
        // the marker step when the binding is absent.
    ],
    exports: [OnboardingService, OnboardingTerminalService],
})
export class OnboardingModule {}
