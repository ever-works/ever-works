import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DataSource, type DataSourceOptions } from 'typeorm';
import { runRenameDirectoriesToWorks } from './utils/rename-directories-to-works';
import { ApiKeyRepository } from './repositories/api-key.repository';
import { WorkRepository } from './repositories/work.repository';
import { WorkAdvancedPromptsRepository } from './repositories/work-advanced-prompts.repository';
import { WorkCustomDomainRepository } from './repositories/work-custom-domain.repository';
import { WorkMemberRepository } from './repositories/work-member.repository';
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

@Module({
    imports: [
        ConfigModule.forFeature(databaseConfig),
        TypeOrmModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: (configService: ConfigService) => {
                const config = configService.get('database');
                const logger = new Logger('DatabaseModule');
                logger.debug(`Using ${config.type} database: ${config.database}`);
                // Defer synchronize so we can run the legacy-rename hook
                // BEFORE TypeORM tries to alter/create tables. Without this,
                // synchronize would see the new entity name `works` and
                // create an empty `works` table, leaving the legacy
                // `directories` data orphaned.
                return { ...config, synchronize: false, originalSynchronize: !!config.synchronize };
            },
            // Custom dataSourceFactory: initialize → rename legacy → synchronize.
            dataSourceFactory: async (options?: DataSourceOptions) => {
                const logger = new Logger('DatabaseModule');
                if (!options) {
                    throw new Error('dataSourceFactory called without options');
                }

                const wantSync = (options as DataSourceOptions & { originalSynchronize?: boolean })
                    .originalSynchronize;
                const cleanOptions: DataSourceOptions = {
                    ...(options as DataSourceOptions),
                };
                // Strip the helper flag — TypeORM will reject unknown fields.
                delete (cleanOptions as DataSourceOptions & { originalSynchronize?: boolean })
                    .originalSynchronize;

                const dataSource = new DataSource(cleanOptions);
                await dataSource.initialize();

                // Run the legacy directory→work rename idempotently before
                // anything else touches the schema.
                const queryRunner = dataSource.createQueryRunner();
                try {
                    await queryRunner.startTransaction();
                    await runRenameDirectoriesToWorks(queryRunner, logger);
                    await queryRunner.commitTransaction();
                } catch (error) {
                    await queryRunner.rollbackTransaction().catch(() => undefined);
                    logger.error(
                        `Legacy directory→work rename failed: ${(error as Error).message}`,
                    );
                    throw error;
                } finally {
                    await queryRunner.release();
                }

                if (wantSync) {
                    logger.debug('Running TypeORM synchronize after rename hook');
                    await dataSource.synchronize();
                }

                return dataSource;
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
        WorkMemberRepository,
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
    ],
    exports: [
        TypeOrmModule,
        ApiKeyRepository,
        WorkRepository,
        WorkAdvancedPromptsRepository,
        WorkCustomDomainRepository,
        WorkMemberRepository,
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
    ],
})
export class DatabaseModule {}
