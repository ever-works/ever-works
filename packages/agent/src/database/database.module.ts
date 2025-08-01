import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DirectoryRepository } from './directory.repository';
import { RefreshTokenRepository } from './refresh-token.repository';
import { OAuthTokenRepository } from './oauth-token.repository';
import { databaseConfig, ENTITIES } from './database.config';
import { UserRepository } from './user.repository';
import { UserGitHubService } from '../services/user-github.service';

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
    providers: [DirectoryRepository, RefreshTokenRepository, UserRepository, OAuthTokenRepository, UserGitHubService],
    exports: [TypeOrmModule, DirectoryRepository, UserRepository, RefreshTokenRepository, OAuthTokenRepository, UserGitHubService],
})
export class DatabaseModule {}
