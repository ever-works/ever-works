import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import { DirectoryRepository } from './directory.repository';
import { databaseConfig } from './database.config';

@Module({
	imports: [
		ConfigModule.forFeature(databaseConfig),
		TypeOrmModule.forRootAsync({
			imports: [ConfigModule],
			useFactory: (configService: ConfigService) => {
				console.log('Database config:', configService.get('database'));
				return configService.get('database');
			},
			inject: [ConfigService]
		}),
		TypeOrmModule.forFeature([Directory, User])
	],
	providers: [DirectoryRepository],
	exports: [TypeOrmModule, DirectoryRepository]
})
export class DatabaseModule {}
