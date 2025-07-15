import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Directory } from '../entities/directory.entity';
import { User } from '../entities/user.entity';
import * as path from 'path';
import * as os from 'os';

export type DatabaseType = 'better-sqlite3' | 'postgres' | 'mysql' | 'mariadb';

export interface DatabaseConfig extends Omit<TypeOrmModuleOptions, 'type'> {
	type: DatabaseType;
	// SQLite specific
	database?: string;
	// PostgreSQL/MySQL/MariaDB specific
	host?: string;
	port?: number;
	username?: string;
	password?: string;
	// Common properties
	entities: any[];
	synchronize: boolean;
	logging: boolean;
}

export const ENTITIES = [Directory, User];

export const databaseConfig = registerAs('database', (): DatabaseConfig => {
	const environment = process.env.NODE_ENV || 'development';
	const appType = process.env.APP_TYPE || 'api'; // 'cli' or 'api'
	let dbType = (process.env.DATABASE_TYPE || 'better-sqlite3') as DatabaseType;

	const baseConfig = {
		entities: ENTITIES,
		synchronize: environment !== 'production',
		logging: process.env.DATABASE_LOGGING === 'true'
	};

	// @ts-ignore
	if (dbType === 'sqlite' || dbType === 'sqlite3') {
		dbType = 'better-sqlite3';
	}

	// SQLite configuration
	if (dbType === 'better-sqlite3') {
		let database: string;

		if (process.env.DATABASE_PATH) {
			database = process.env.DATABASE_PATH;
		} else if (appType === 'cli') {
			const dbDir = path.join(os.homedir(), '.ever-works');
			database = path.join(dbDir, 'ever-works.db');
		} else if (environment === 'test') {
			database = ':memory:';
		} else {
			// API apps default to in-memory for development, can be overridden
			database =
				process.env.DATABASE_IN_MEMORY === 'false' ? path.join(os.tmpdir(), 'ever-works-api.db') : ':memory:';
		}

		// Ensure directory exists for file-based SQLite databases (SQLite-specific logic)
		if (database !== ':memory:' && !database.startsWith(':')) {
			const fs = require('fs');
			const dbDir = path.dirname(database);
			if (!fs.existsSync(dbDir)) {
				fs.mkdirSync(dbDir, { recursive: true });
			}
		}

		return {
			...baseConfig,
			type: 'better-sqlite3',
			database
		};
	}

	// PostgreSQL configuration
	if (dbType === 'postgres') {
		return {
			...baseConfig,
			type: 'postgres',
			host: process.env.DATABASE_HOST || 'localhost',
			port: parseInt(process.env.DATABASE_PORT || '5432'),
			username: process.env.DATABASE_USERNAME || 'postgres',
			password: process.env.DATABASE_PASSWORD || '',
			database: process.env.DATABASE_NAME || 'ever_works'
		};
	}

	// MySQL configuration
	if (dbType === 'mysql') {
		return {
			...baseConfig,
			type: 'mysql',
			host: process.env.DATABASE_HOST || 'localhost',
			port: parseInt(process.env.DATABASE_PORT || '3306'),
			username: process.env.DATABASE_USERNAME || 'root',
			password: process.env.DATABASE_PASSWORD || '',
			database: process.env.DATABASE_NAME || 'ever_works'
		};
	}

	// MariaDB configuration
	if (dbType === 'mariadb') {
		return {
			...baseConfig,
			type: 'mariadb',
			host: process.env.DATABASE_HOST || 'localhost',
			port: parseInt(process.env.DATABASE_PORT || '3306'),
			username: process.env.DATABASE_USERNAME || 'root',
			password: process.env.DATABASE_PASSWORD || '',
			database: process.env.DATABASE_NAME || 'ever_works'
		};
	}

	// Default to SQLite if unknown type
	return {
		...baseConfig,
		type: 'better-sqlite3',
		database: ':memory:'
	};
});

export const getDatabaseConfig = (): TypeOrmModuleOptions => {
	const config = databaseConfig();
	return config as TypeOrmModuleOptions;
};
