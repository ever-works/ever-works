import { MigrationInterface, QueryRunner } from 'typeorm';

export class AlignAuthRuntimeSingularTables1760000001000 implements MigrationInterface {
    name = 'AlignAuthRuntimeSingularTables1760000001000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "account" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "accountId" varchar NOT NULL,
                "providerId" varchar NOT NULL,
                "accessToken" text,
                "refreshToken" text,
                "accessTokenExpiresAt" datetime,
                "refreshTokenExpiresAt" datetime,
                "expiresAt" datetime,
                "scope" varchar,
                "password" text,
                "idToken" text,
                "tokenType" varchar,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
                CONSTRAINT "FK_account_user" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_account_provider_account" ON "account" ("providerId", "accountId")`,
        );
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_account_user_provider" ON "account" ("userId", "providerId")`,
        );

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "session" (
                "id" varchar PRIMARY KEY NOT NULL,
                "userId" varchar NOT NULL,
                "token" varchar NOT NULL,
                "expiresAt" datetime NOT NULL,
                "ipAddress" varchar,
                "userAgent" varchar,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                "updatedAt" datetime NOT NULL DEFAULT (datetime('now')),
                CONSTRAINT "FK_session_user" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE NO ACTION
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_session_token" ON "session" ("token")`,
        );
        await queryRunner.query(
            `CREATE INDEX IF NOT EXISTS "IDX_session_userId" ON "session" ("userId")`,
        );

        await queryRunner.query(`
            CREATE TABLE IF NOT EXISTS "verification" (
                "id" varchar PRIMARY KEY NOT NULL,
                "identifier" varchar NOT NULL,
                "value" text NOT NULL,
                "expiresAt" datetime NOT NULL,
                "createdAt" datetime NOT NULL DEFAULT (datetime('now')),
                "updatedAt" datetime DEFAULT (datetime('now'))
            )
        `);
        await queryRunner.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_verification_identifier_value" ON "verification" ("identifier", "value")`,
        );

        const hasPluralAccounts = await queryRunner.hasTable('accounts');
        const hasPluralSessions = await queryRunner.hasTable('sessions');
        const hasPluralVerifications = await queryRunner.hasTable('verifications');

        const [{ count: accountCount }] = (await queryRunner.query(
            `SELECT COUNT(*) as count FROM "account"`,
        )) as Array<{ count: number | string }>;
        const [{ count: sessionCount }] = (await queryRunner.query(
            `SELECT COUNT(*) as count FROM "session"`,
        )) as Array<{ count: number | string }>;
        const [{ count: verificationCount }] = (await queryRunner.query(
            `SELECT COUNT(*) as count FROM "verification"`,
        )) as Array<{ count: number | string }>;

        if (hasPluralAccounts && Number(accountCount) === 0) {
            await queryRunner.query(`
                INSERT INTO "account" (
                    "id", "userId", "accountId", "providerId", "accessToken", "refreshToken",
                    "accessTokenExpiresAt", "refreshTokenExpiresAt", "expiresAt", "scope",
                    "password", "idToken", "tokenType", "createdAt", "updatedAt"
                )
                SELECT
                    "id", "userId", "accountId", "providerId", "accessToken", "refreshToken",
                    "accessTokenExpiresAt", "refreshTokenExpiresAt", "expiresAt", "scope",
                    "password", "idToken", "tokenType", "createdAt", "updatedAt"
                FROM "accounts"
            `);
        }

        if (hasPluralSessions && Number(sessionCount) === 0) {
            await queryRunner.query(`
                INSERT INTO "session" (
                    "id", "userId", "token", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"
                )
                SELECT
                    "id", "userId", "token", "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"
                FROM "sessions"
            `);
        }

        if (hasPluralVerifications && Number(verificationCount) === 0) {
            await queryRunner.query(`
                INSERT INTO "verification" (
                    "id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"
                )
                SELECT
                    "id", "identifier", "value", "expiresAt", "createdAt", "updatedAt"
                FROM "verifications"
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_verification_identifier_value"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "verification"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_session_userId"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_session_token"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "session"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_account_user_provider"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_account_provider_account"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "account"`);
    }
}
