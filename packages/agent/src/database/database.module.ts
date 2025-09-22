import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DirectoryRepository } from './repositories/directory.repository';
import { RefreshTokenRepository } from './repositories/refresh-token.repository';
import { OAuthTokenRepository } from './repositories/oauth-token.repository';
import { databaseConfig, ENTITIES } from './database.config';
import { UserRepository } from './repositories/user.repository';
import { UserGitHubService } from './user-github.service';
import { ChatHistoryRepository } from './repositories/chat-history.repository';

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
        UserGitHubService,
        RefreshTokenRepository,
        UserRepository,
        OAuthTokenRepository,
        ChatHistoryRepository,
    ],
    exports: [
        TypeOrmModule,
        UserGitHubService,
        DirectoryRepository,
        UserRepository,
        RefreshTokenRepository,
        OAuthTokenRepository,
        ChatHistoryRepository,
    ],
})
export class DatabaseModule {}
