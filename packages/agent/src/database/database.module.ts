import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApiKeyRepository } from './repositories/api-key.repository';
import { WorkRepository } from './repositories/work.repository';
import { WorkAdvancedPromptsRepository } from './repositories/work-advanced-prompts.repository';
import { WorkCustomDomainRepository } from './repositories/work-custom-domain.repository';
import { WorkDeploymentRepository } from './repositories/work-deployment.repository';
import { WorkCodeUpdateRepository } from './repositories/work-code-update.repository';
import { WorkMemberRepository } from './repositories/work-member.repository';
import { WorkInvitationRepository } from './repositories/work-invitation.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { AuthAccountRepository } from './repositories/auth-account.repository';
import { databaseConfig, ENTITIES } from './database.config';
import { UserRepository } from './repositories/user.repository';
import { WorkGenerationHistoryRepository } from './repositories/work-generation-history.repository';
import { SubscriptionPlanRepository } from './repositories/subscription-plan.repository';
import { UserSubscriptionRepository } from './repositories/user-subscription.repository';
import { WorkScheduleRepository } from './repositories/work-schedule.repository';
import { UsageLedgerRepository } from './repositories/usage-ledger.repository';
import { NotificationRepository } from './repositories/notification.repository';
import { ActivityLogRepository } from './repositories/activity-log.repository';
import { ConversationRepository } from './repositories/conversation.repository';
import { GitHubAppInstallationRepository } from './repositories/github-app-installation.repository';
import { GitHubAppInstallationRepoRepository } from './repositories/github-app-installation-repository.repository';
import { GitHubAppUserLinkRepository } from './repositories/github-app-user-link.repository';
import { OnboardingRequestRepository } from './repositories/onboarding-request.repository';
import { TemplateRepository } from './repositories/template.repository';
import { UserTemplatePreferenceRepository } from './repositories/user-template-preference.repository';
import { WebhookSubscriptionRepository } from './repositories/webhook-subscription.repository';

@Module({
    imports: [
        ConfigModule.forFeature(databaseConfig),
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: (configService: ConfigService) => {
                const config = configService.get('database');
                const logger = new Logger('DatabaseModule');
                logger.debug(`Using ${config.type} database: ${config.database}`);
                return config;
            },
            inject: [ConfigService],
        }),
        TypeOrmModule.forFeature(ENTITIES),
    ],
    providers: [
        ApiKeyRepository,
        WorkRepository,
        WorkAdvancedPromptsRepository,
        WorkCustomDomainRepository,
        WorkDeploymentRepository,
        WorkCodeUpdateRepository,
        WorkMemberRepository,
        WorkInvitationRepository,
        RefreshTokenRepository,
        UserRepository,
        AuthAccountRepository,
        WorkGenerationHistoryRepository,
        SubscriptionPlanRepository,
        UserSubscriptionRepository,
        WorkScheduleRepository,
        UsageLedgerRepository,
        NotificationRepository,
        ActivityLogRepository,
        ConversationRepository,
        GitHubAppInstallationRepository,
        GitHubAppInstallationRepoRepository,
        GitHubAppUserLinkRepository,
        OnboardingRequestRepository,
        TemplateRepository,
        UserTemplatePreferenceRepository,
        WebhookSubscriptionRepository,
    ],
    exports: [
        TypeOrmModule,
        ApiKeyRepository,
        WorkRepository,
        WorkAdvancedPromptsRepository,
        WorkCustomDomainRepository,
        WorkDeploymentRepository,
        WorkCodeUpdateRepository,
        WorkMemberRepository,
        WorkInvitationRepository,
        UserRepository,
        RefreshTokenRepository,
        AuthAccountRepository,
        WorkGenerationHistoryRepository,
        SubscriptionPlanRepository,
        UserSubscriptionRepository,
        WorkScheduleRepository,
        UsageLedgerRepository,
        NotificationRepository,
        ActivityLogRepository,
        ConversationRepository,
        GitHubAppInstallationRepository,
        GitHubAppInstallationRepoRepository,
        GitHubAppUserLinkRepository,
        OnboardingRequestRepository,
        TemplateRepository,
        UserTemplatePreferenceRepository,
        WebhookSubscriptionRepository,
    ],
})
export class DatabaseModule {}
