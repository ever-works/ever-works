import { Logger, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DirectoryRepository } from './directory.repository';
import { databaseConfig, ENTITIES } from './database.config';

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
			inject: [ConfigService]
		}),
		TypeOrmModule.forFeature(ENTITIES)
	],
	providers: [DirectoryRepository],
	exports: [TypeOrmModule, DirectoryRepository]
})
export class DatabaseModule {}
