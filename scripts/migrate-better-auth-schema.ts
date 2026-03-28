/**
 * Migration script: moves BetterAuth data from ba_* tables to the clean schema.
 *
 * Target schema:
 * - users (existing application table reused for BetterAuth user records)
 * - accounts
 * - sessions
 * - verifications
 *
 * This script is idempotent and does not drop the old ba_* tables.
 */

import { configDotenv } from 'dotenv';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { DataSource, QueryRunner, Table, TableForeignKey } from 'typeorm';
import { ENTITIES } from '../packages/agent/src/database/database.config';
import * as path from 'path';
import * as os from 'os';

async function ensureTargetTables(queryRunner: QueryRunner) {
	if (!(await queryRunner.hasTable('accounts'))) {
		await queryRunner.createTable(
			new Table({
				name: 'accounts',
				columns: [
					{ name: 'id', type: 'varchar', isPrimary: true, isNullable: false },
					{ name: 'userId', type: 'varchar', isNullable: false },
					{ name: 'accountId', type: 'varchar', isNullable: false },
					{ name: 'providerId', type: 'varchar', isNullable: false },
					{ name: 'accessToken', type: 'text', isNullable: true },
					{ name: 'refreshToken', type: 'text', isNullable: true },
					{ name: 'accessTokenExpiresAt', type: 'datetime', isNullable: true },
					{ name: 'refreshTokenExpiresAt', type: 'datetime', isNullable: true },
					{ name: 'expiresAt', type: 'datetime', isNullable: true },
					{ name: 'scope', type: 'varchar', isNullable: true },
					{ name: 'password', type: 'text', isNullable: true },
					{ name: 'idToken', type: 'text', isNullable: true },
					{ name: 'tokenType', type: 'varchar', isNullable: true },
					{ name: 'createdAt', type: 'datetime', isNullable: false, default: "(datetime('now'))" },
					{ name: 'updatedAt', type: 'datetime', isNullable: false, default: "(datetime('now'))" }
				],
				foreignKeys: [
					new TableForeignKey({
						columnNames: ['userId'],
						referencedTableName: 'users',
						referencedColumnNames: ['id'],
						onDelete: 'CASCADE'
					})
				]
			}),
			true
		);
	}

	if (!(await queryRunner.hasTable('sessions'))) {
		await queryRunner.createTable(
			new Table({
				name: 'sessions',
				columns: [
					{ name: 'id', type: 'varchar', isPrimary: true, isNullable: false },
					{ name: 'userId', type: 'varchar', isNullable: false },
					{ name: 'token', type: 'varchar', isNullable: false, isUnique: true },
					{ name: 'expiresAt', type: 'datetime', isNullable: false },
					{ name: 'ipAddress', type: 'varchar', isNullable: true },
					{ name: 'userAgent', type: 'varchar', isNullable: true },
					{ name: 'createdAt', type: 'datetime', isNullable: false, default: "(datetime('now'))" },
					{ name: 'updatedAt', type: 'datetime', isNullable: false, default: "(datetime('now'))" }
				],
				foreignKeys: [
					new TableForeignKey({
						columnNames: ['userId'],
						referencedTableName: 'users',
						referencedColumnNames: ['id'],
						onDelete: 'CASCADE'
					})
				]
			}),
			true
		);
	}

	if (!(await queryRunner.hasTable('verifications'))) {
		await queryRunner.createTable(
			new Table({
				name: 'verifications',
				columns: [
					{ name: 'id', type: 'varchar', isPrimary: true, isNullable: false },
					{ name: 'identifier', type: 'varchar', isNullable: false },
					{ name: 'value', type: 'text', isNullable: false },
					{ name: 'expiresAt', type: 'datetime', isNullable: false },
					{ name: 'createdAt', type: 'datetime', isNullable: false, default: "(datetime('now'))" },
					{ name: 'updatedAt', type: 'datetime', isNullable: true, default: "(datetime('now'))" }
				]
			}),
			true
		);
	}
}

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
	const userIdMap = new Map<string, string>();

	try {
		await ensureTargetTables(queryRunner);

		const hasBaUser = await queryRunner.hasTable('ba_user');
		const hasBaAccount = await queryRunner.hasTable('ba_account');
		const hasBaSession = await queryRunner.hasTable('ba_session');
		const hasBaVerification = await queryRunner.hasTable('ba_verification');

		if (!hasBaUser && !hasBaAccount && !hasBaSession && !hasBaVerification) {
			console.log('No ba_* tables found. Nothing to migrate.');
			return;
		}

		const baUsers = hasBaUser ? await queryRunner.query('SELECT * FROM ba_user') : [];
		console.log(`Found ${baUsers.length} BetterAuth users to reconcile`);

		for (const baUser of baUsers) {
			const existingById = await queryRunner.query(`SELECT id FROM users WHERE id = ${p(1)}`, [baUser.id]);

			if (existingById.length > 0) {
				userIdMap.set(baUser.id, existingById[0].id);
				continue;
			}

			const existingByEmail = await queryRunner.query(`SELECT id FROM users WHERE email = ${p(1)}`, [
				baUser.email
			]);

			if (existingByEmail.length > 0) {
				userIdMap.set(baUser.id, existingByEmail[0].id);
				continue;
			}

			const randomPassword = await bcrypt.hash(randomBytes(16).toString('hex'), 10);
			await queryRunner.query(
				`INSERT INTO users (id, username, email, password, "registrationProvider", avatar, "emailVerified", "isActive", "createdAt", "updatedAt")
				 VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)})`,
				[
					baUser.id,
					baUser.name || baUser.email.split('@')[0],
					baUser.email,
					randomPassword,
					'local',
					baUser.image || null,
					baUser.emailVerified || false,
					true,
					baUser.createdAt || new Date(),
					baUser.updatedAt || new Date()
				]
			);
			userIdMap.set(baUser.id, baUser.id);
		}

		if (hasBaAccount) {
			const accounts = await queryRunner.query('SELECT * FROM ba_account');
			console.log(`Found ${accounts.length} BetterAuth accounts to migrate`);

			for (const account of accounts) {
				const targetUserId = userIdMap.get(account.userId) || account.userId;
				const existing = await queryRunner.query(`SELECT id FROM accounts WHERE id = ${p(1)}`, [account.id]);

				if (existing.length > 0) {
					continue;
				}

				await queryRunner.query(
					`INSERT INTO accounts (id, "userId", "accountId", "providerId", "accessToken", "refreshToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "expiresAt", scope, password, "idToken", "tokenType", "createdAt", "updatedAt")
					 VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)}, ${p(13)}, ${p(14)}, ${p(15)})`,
					[
						account.id,
						targetUserId,
						account.accountId,
						account.providerId,
						account.accessToken || null,
						account.refreshToken || null,
						account.accessTokenExpiresAt || null,
						account.refreshTokenExpiresAt || null,
						account.expiresAt || null,
						account.scope || null,
						account.password || null,
						account.idToken || null,
						account.tokenType || null,
						account.createdAt || new Date(),
						account.updatedAt || new Date()
					]
				);
			}
		}

		if (hasBaSession) {
			const sessions = await queryRunner.query('SELECT * FROM ba_session');
			console.log(`Found ${sessions.length} BetterAuth sessions to migrate`);

			for (const session of sessions) {
				const targetUserId = userIdMap.get(session.userId) || session.userId;
				const existing = await queryRunner.query(`SELECT id FROM sessions WHERE id = ${p(1)}`, [session.id]);

				if (existing.length > 0) {
					continue;
				}

				await queryRunner.query(
					`INSERT INTO sessions (id, "userId", token, "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt")
					 VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)})`,
					[
						session.id,
						targetUserId,
						session.token,
						session.expiresAt,
						session.ipAddress || null,
						session.userAgent || null,
						session.createdAt || new Date(),
						session.updatedAt || new Date()
					]
				);
			}
		}

		if (hasBaVerification) {
			const verifications = await queryRunner.query('SELECT * FROM ba_verification');
			console.log(`Found ${verifications.length} BetterAuth verifications to migrate`);

			for (const verification of verifications) {
				const existing = await queryRunner.query(`SELECT id FROM verifications WHERE id = ${p(1)}`, [
					verification.id
				]);

				if (existing.length > 0) {
					continue;
				}

				await queryRunner.query(
					`INSERT INTO verifications (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
					 VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)})`,
					[
						verification.id,
						verification.identifier,
						verification.value,
						verification.expiresAt,
						verification.createdAt || new Date(),
						verification.updatedAt || new Date()
					]
				);
			}
		}

		console.log('BetterAuth schema migration complete.');
		console.log('Old ba_* tables were left in place for manual cleanup after verification.');
	} finally {
		await queryRunner.release();
		await dataSource.destroy();
	}
}

main().catch((error) => {
	console.error('Migration failed:', error);
	process.exit(1);
});
