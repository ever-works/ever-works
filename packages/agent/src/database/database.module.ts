import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DirectoryRepository } from './repositories/directory.repository';
import { DirectoryAdvancedPromptsRepository } from './repositories/directory-advanced-prompts.repository';
import { DirectoryMemberRepository } from './repositories/directory-member.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { OAuthTokenRepository } from './repositories/oauth-token.repository';
import { databaseConfig, ENTITIES } from './database.config';
import { UserRepository } from './repositories/user.repository';
import { UserGitHubService } from './user-github.service';
import { ChatHistoryRepository } from './repositories/chat-history.repository';
import { DirectoryGenerationHistoryRepository } from './repositories/directory-generation-history.repository';
import { SubscriptionPlanRepository } from './repositories/subscription-plan.repository';
import { UserSubscriptionRepository } from './repositories/user-subscription.repository';
import { DirectoryScheduleRepository } from './repositories/directory-schedule.repository';
import { UsageLedgerRepository } from './repositories/usage-ledger.repository';
import { NotificationRepository } from './repositories/notification.repository';

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
        DirectoryRepository,
        DirectoryAdvancedPromptsRepository,
        DirectoryMemberRepository,
        UserGitHubService,
        RefreshTokenRepository,
        UserRepository,
        OAuthTokenRepository,
        ChatHistoryRepository,
        DirectoryGenerationHistoryRepository,
        SubscriptionPlanRepository,
        UserSubscriptionRepository,
        DirectoryScheduleRepository,
        UsageLedgerRepository,
        NotificationRepository,
    ],
    exports: [
        TypeOrmModule,
        UserGitHubService,
        DirectoryRepository,
        DirectoryAdvancedPromptsRepository,
        DirectoryMemberRepository,
        UserRepository,
        RefreshTokenRepository,
        OAuthTokenRepository,
        ChatHistoryRepository,
        DirectoryGenerationHistoryRepository,
        SubscriptionPlanRepository,
        UserSubscriptionRepository,
        DirectoryScheduleRepository,
        UsageLedgerRepository,
        NotificationRepository,
    ],
})
export class DatabaseModule {}
