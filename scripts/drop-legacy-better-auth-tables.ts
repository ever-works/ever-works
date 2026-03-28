/**
 * Cleanup script: drops the legacy BetterAuth ba_* tables after migration verification.
 *
 * Tables removed:
 * - ba_account
 * - ba_session
 * - ba_verification
 * - ba_user
 */

import { configDotenv } from 'dotenv';
import { DataSource } from 'typeorm';
import { ENTITIES } from '../packages/agent/src/database/database.config';
import * as path from 'path';
import * as os from 'os';

async function main() {
	configDotenv({ path: path.resolve(process.cwd(), 'apps/api/.env') });

	const rawDbType = process.env.DATABASE_TYPE || process.env.DB_TYPE || 'better-sqlite3';
	const dbType = (rawDbType === 'sqlite' || rawDbType === 'sqlite3' ? 'better-sqlite3' : rawDbType) as any;
	const isPostgres = dbType === 'postgres';
	const sqlitePath =
		process.env.DATABASE_PATH ||
		process.env.DB_PATH ||
		(process.env.DATABASE_IN_MEMORY === 'true' ? ':memory:' : path.join(os.tmpdir(), 'ever-works-api.db'));

	const dataSource = new DataSource({
		type: dbType,
		...(isPostgres
			? {
					host: process.env.DATABASE_HOST || process.env.DB_HOST || 'localhost',
					port: parseInt(process.env.DATABASE_PORT || process.env.DB_PORT || '5432'),
					username: process.env.DATABASE_USERNAME || process.env.DB_USER || 'postgres',
					password: process.env.DATABASE_PASSWORD || process.env.DB_PASS || '',
					database: process.env.DATABASE_NAME || process.env.DB_NAME || 'ever_works'
				}
			: {
					database: sqlitePath
				}),
		entities: ENTITIES,
		synchronize: false
	});

	await dataSource.initialize();
	console.log('Connected to database');

	const queryRunner = dataSource.createQueryRunner();

	try {
		const tablesInDropOrder = ['ba_account', 'ba_session', 'ba_verification', 'ba_user'];

		for (const tableName of tablesInDropOrder) {
			if (!(await queryRunner.hasTable(tableName))) {
				console.log(`Skipping ${tableName}: not present`);
				continue;
			}

			await queryRunner.dropTable(tableName, true, true, true);
			console.log(`Dropped ${tableName}`);
		}

		console.log('Legacy BetterAuth tables removed.');
	} finally {
		await queryRunner.release();
		await dataSource.destroy();
	}
}

main().catch((error) => {
	console.error('Legacy BetterAuth cleanup failed:', error);
	process.exit(1);
});
