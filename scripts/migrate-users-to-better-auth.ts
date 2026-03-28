/**
 * Migration script: Copies existing users and OAuth tokens to BetterAuth tables.
 *
 * This script is idempotent — it uses INSERT ON CONFLICT DO NOTHING (Postgres)
 * or catches unique constraint errors (SQLite) so re-running is safe.
 *
 * Run: npx ts-node scripts/migrate-users-to-better-auth.ts
 *
 * Prerequisite: BetterAuth tables (users, accounts, sessions, verifications)
 * must already exist (created by TypeORM synchronize or migration).
 */

import { configDotenv } from 'dotenv';
import { randomBytes, randomUUID } from 'crypto';
import * as bcrypt from 'bcrypt';
import { DataSource } from 'typeorm';
import { ENTITIES } from '../packages/agent/src/database/database.config';
import * as path from 'path';
import * as os from 'os';

async function main() {
	configDotenv({ path: path.resolve(process.cwd(), 'apps/api/.env') });

	const rawDbType = process.env.DATABASE_TYPE || process.env.DB_TYPE || 'better-sqlite3';
	const dbType = (rawDbType === 'sqlite' || rawDbType === 'sqlite3' ? 'better-sqlite3' : rawDbType) as any;
	const isPostgres = dbType === 'postgres';
	const p = (index: number) => (isPostgres ? `$${index}` : '?');
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

	let usersCreated = 0;
	let accountsCreated = 0;
	let oauthSynced = 0;
	let errors = 0;

	try {
		// 1. Ensure users table is BetterAuth-compatible
		console.log('\n--- Reconciling users for BetterAuth ---');
		const users = await queryRunner.query('SELECT * FROM users');
		console.log(`Found ${users.length} users to reconcile`);

		for (const user of users) {
			try {
				if (!user.password) {
					const randomPassword = await bcrypt.hash(randomBytes(16).toString('hex'), 10);
					await queryRunner.query(`UPDATE users SET password = ${p(1)} WHERE id = ${p(2)}`, [
						randomPassword,
						user.id
					]);
				}
				usersCreated++;
			} catch (error: any) {
				console.error(`Failed to reconcile user ${user.id} (${user.email}):`, error.message);
				errors++;
			}
		}

		// 2. Create credential accounts in accounts for email/password users
		console.log('\n--- Creating credential accounts in accounts ---');
		for (const user of users) {
			try {
				const existing = await queryRunner.query(
					`SELECT id FROM accounts WHERE "userId" = ${p(1)} AND "providerId" = 'credential'`,
					[user.id]
				);

				if (existing.length > 0) {
					continue;
				}

				const accountId = randomUUID();
				await queryRunner.query(
					`INSERT INTO accounts (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
					 VALUES (${p(1)}, ${p(2)}, ${p(3)}, 'credential', ${p(4)}, ${p(5)}, ${p(6)})`,
					[
						accountId,
						user.id,
						user.id, // accountId = userId for credential provider
						user.password, // bcrypt hash preserved as-is
						user.createdAt || new Date(),
						user.updatedAt || new Date()
					]
				);
				accountsCreated++;
			} catch (error: any) {
				if (error.message?.includes('UNIQUE') || error.message?.includes('duplicate')) {
					continue;
				}
				console.error(`Failed to create credential account for user ${user.id}:`, error.message);
				errors++;
			}
		}

		// 3. Sync oauth_tokens to accounts
		console.log('\n--- Syncing OAuth tokens to accounts ---');
		const oauthTokens = await queryRunner.query('SELECT * FROM oauth_tokens');
		console.log(`Found ${oauthTokens.length} OAuth tokens to sync`);

		for (const token of oauthTokens) {
			try {
				const existing = await queryRunner.query(
					`SELECT id FROM accounts WHERE "userId" = ${p(1)} AND "providerId" = ${p(2)}`,
					[token.userId, token.provider]
				);

				if (existing.length > 0) {
					continue;
				}

				// Extract accountId from metadata if available
				let accountId = token.userId;
				if (token.metadata) {
					const metadata = typeof token.metadata === 'string' ? JSON.parse(token.metadata) : token.metadata;
					accountId = metadata?.login || metadata?.sub || token.username || token.userId;
				}

				const id = randomUUID();
				await queryRunner.query(
					`INSERT INTO accounts (id, "userId", "accountId", "providerId", "accessToken", "refreshToken", scope, "createdAt", "updatedAt")
					 VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)})`,
					[
						id,
						token.userId,
						accountId,
						token.provider,
						token.accessToken || null,
						token.refreshToken || null,
						token.scope || null,
						token.createdAt || new Date(),
						token.updatedAt || new Date()
					]
				);
				oauthSynced++;
			} catch (error: any) {
				if (error.message?.includes('UNIQUE') || error.message?.includes('duplicate')) {
					continue;
				}
				console.error(`Failed to sync OAuth token ${token.id} (${token.provider}):`, error.message);
				errors++;
			}
		}

		console.log('\n=== Migration Complete ===');
		console.log(`Users reconciled for BetterAuth: ${usersCreated}`);
		console.log(`Credential accounts created: ${accountsCreated}`);
		console.log(`OAuth accounts synced: ${oauthSynced}`);
		console.log(`Errors: ${errors}`);
	} finally {
		await queryRunner.release();
		await dataSource.destroy();
	}
}

main().catch((error) => {
	console.error('Migration failed:', error);
	process.exit(1);
});
