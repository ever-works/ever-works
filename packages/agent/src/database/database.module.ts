import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { databaseConfig, ENTITIES } from './database.config';
import { REPOSITORY_PROVIDERS } from './_repository-inventory';

/**
 * Repository providers + exports are sourced from
 * `_repository-inventory.ts` (EW-638) so adding a new repository is a
 * single, deliberate edit in one place instead of the previous three
 * (module.ts providers, module.ts exports, module.spec.ts assertion).
 */
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
    providers: [...REPOSITORY_PROVIDERS],
    exports: [TypeOrmModule, ...REPOSITORY_PROVIDERS],
})
export class DatabaseModule {}
