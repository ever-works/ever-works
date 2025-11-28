import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
// Use relative path for ts-node compatibility (workspace package resolution doesn't work with ts-node)
import { databaseConfig } from '../../packages/agent/src/database/database.config';

// Load environment variables
dotenv.config();

/**
 * Usage:
 *   pnpm migration:generate src/migrations/MyMigration
 *   pnpm migration:run
 *   pnpm migration:revert
 */

export default new DataSource({
    ...(databaseConfig() as any),

    migrationsRun: false,
    migrationsTableName: 'migrations',
    migrationsTransactionMode: 'all',
    migrations: [__dirname + '/src/migrations/**/*{.js,.ts}'],
});
