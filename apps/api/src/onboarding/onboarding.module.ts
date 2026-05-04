import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OnboardingRequest, WebhookSubscription } from '@ever-works/agent/entities';
import {
    ONBOARDING_ACCOUNT_UPSERT,
    ONBOARDING_GIT_PROVIDER,
    ONBOARDING_WORK_CREATOR,
    OnboardingRequestRepository,
    StateMarkerService,
    WebhookDeliveryService,
    WebhookSubscriptionRepository,
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

@Module({
    imports: [
        TypeOrmModule.forFeature([OnboardingRequest, WebhookSubscription]),
        FacadesModule,
        DatabaseModule,
        WorkModule,
    ],
    controllers: [OnboardingController, WellKnownController],
    providers: [
        OnboardingService,
        OnboardingTerminalService,
        OnboardingAccountAdapter,
        OnboardingWorkAdapter,
        WorksManifestService,
        WebhookDeliveryService,
        OnboardingRequestRepository,
        WebhookSubscriptionRepository,
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
