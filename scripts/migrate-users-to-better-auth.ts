/**
 * Migration script: Copies existing users and OAuth tokens to BetterAuth tables.
 *
 * This script is idempotent — it uses INSERT ON CONFLICT DO NOTHING (Postgres)
 * or catches unique constraint errors (SQLite) so re-running is safe.
 *
 * Run: npx ts-node scripts/migrate-users-to-better-auth.ts
 *
 * Prerequisite: BetterAuth tables (ba_user, ba_session, ba_account, ba_verification)
 * must already exist (created by TypeORM synchronize or migration).
 */

import { DataSource } from 'typeorm';
import { ENTITIES } from '../packages/agent/src/database/database.config';

async function main() {
	const dbType = (process.env.DB_TYPE || 'better-sqlite3') as any;
	const isPostgres = dbType === 'postgres';

	const dataSource = new DataSource({
		type: dbType,
		...(isPostgres
			? {
					host: process.env.DB_HOST || 'localhost',
					port: parseInt(process.env.DB_PORT || '5432'),
					username: process.env.DB_USER || 'postgres',
					password: process.env.DB_PASS || '',
					database: process.env.DB_NAME || 'ever_works',
				}
			: {
					database: process.env.DB_PATH || ':memory:',
				}),
		entities: ENTITIES,
		synchronize: false,
	});

	await dataSource.initialize();
	console.log('Connected to database');

	const queryRunner = dataSource.createQueryRunner();

	let usersCreated = 0;
	let accountsCreated = 0;
	let oauthSynced = 0;
	let errors = 0;

	try {
		// 1. Migrate users to ba_user
		console.log('\n--- Migrating users to ba_user ---');
		const users = await queryRunner.query('SELECT * FROM users');
		console.log(`Found ${users.length} users to migrate`);

		for (const user of users) {
			try {
				const existing = await queryRunner.query('SELECT id FROM ba_user WHERE id = $1', [
					user.id,
				]);

				if (existing.length > 0) {
					continue; // Already migrated
				}

				await queryRunner.query(
					`INSERT INTO ba_user (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
					 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[
						user.id,
						user.username,
						user.email,
						user.emailVerified || false,
						user.avatar || null,
						user.createdAt || new Date(),
						user.updatedAt || new Date(),
					],
				);
				usersCreated++;
			} catch (error: any) {
				if (error.message?.includes('UNIQUE') || error.message?.includes('duplicate')) {
					continue; // Idempotent
				}
				console.error(`Failed to migrate user ${user.id} (${user.email}):`, error.message);
				errors++;
			}
		}

		// 2. Create credential accounts in ba_account for email/password users
		console.log('\n--- Creating credential accounts in ba_account ---');
		for (const user of users) {
			try {
				const existing = await queryRunner.query(
					`SELECT id FROM ba_account WHERE "userId" = $1 AND "providerId" = 'credential'`,
					[user.id],
				);

				if (existing.length > 0) {
					continue;
				}

				const accountId = require('crypto').randomUUID();
				await queryRunner.query(
					`INSERT INTO ba_account (id, "userId", "accountId", "providerId", password, "createdAt", "updatedAt")
					 VALUES ($1, $2, $3, 'credential', $4, $5, $6)`,
					[
						accountId,
						user.id,
						user.id, // accountId = userId for credential provider
						user.password, // bcrypt hash preserved as-is
						user.createdAt || new Date(),
						user.updatedAt || new Date(),
					],
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

		// 3. Sync oauth_tokens to ba_account
		console.log('\n--- Syncing OAuth tokens to ba_account ---');
		const oauthTokens = await queryRunner.query('SELECT * FROM oauth_tokens');
		console.log(`Found ${oauthTokens.length} OAuth tokens to sync`);

		for (const token of oauthTokens) {
			try {
				const existing = await queryRunner.query(
					`SELECT id FROM ba_account WHERE "userId" = $1 AND "providerId" = $2`,
					[token.userId, token.provider],
				);

				if (existing.length > 0) {
					continue;
				}

				// Extract accountId from metadata if available
				let accountId = token.userId;
				if (token.metadata) {
					const metadata =
						typeof token.metadata === 'string'
							? JSON.parse(token.metadata)
							: token.metadata;
					accountId = metadata?.login || metadata?.sub || token.username || token.userId;
				}

				const id = require('crypto').randomUUID();
				await queryRunner.query(
					`INSERT INTO ba_account (id, "userId", "accountId", "providerId", "accessToken", "refreshToken", scope, "createdAt", "updatedAt")
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[
						id,
						token.userId,
						accountId,
						token.provider,
						token.accessToken || null,
						token.refreshToken || null,
						token.scope || null,
						token.createdAt || new Date(),
						token.updatedAt || new Date(),
					],
				);
				oauthSynced++;
			} catch (error: any) {
				if (error.message?.includes('UNIQUE') || error.message?.includes('duplicate')) {
					continue;
				}
				console.error(
					`Failed to sync OAuth token ${token.id} (${token.provider}):`,
					error.message,
				);
				errors++;
			}
		}

		console.log('\n=== Migration Complete ===');
		console.log(`Users created in ba_user: ${usersCreated}`);
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
