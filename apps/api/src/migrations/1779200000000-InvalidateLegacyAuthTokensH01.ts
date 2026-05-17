import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * H-01 — invalidate-on-deploy migration for at-rest auth tokens.
 *
 * Before this commit, `emailVerificationToken` and `passwordResetToken`
 * were stored as raw 64-char hex strings (256 bits of entropy) directly in
 * the `users` table. After this commit, the application stores
 * `sha256(token)` in the same column and looks up by the same hash.
 *
 * Any token issued before this deploy is a plaintext value; the new
 * code can't match it against itself. Per audit Q-8, the operator chose
 * **invalidate-on-deploy** rather than a dual-read window — so we null
 * out every in-flight value. The affected users (handful of internal
 * testers as of 2026-05-17) will simply re-request a verification email
 * or a fresh password-reset link.
 *
 * Sessions (`auth_sessions.token`) are NOT touched here. They're still
 * stored in plaintext on read; converting those to hashed-at-rest needs
 * a separate column + every authenticated-request lookup path updated,
 * and is queued as a focused follow-up PR.
 */
export class InvalidateLegacyAuthTokensH01_1779200000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            UPDATE "users"
               SET "emailVerificationToken" = NULL,
                   "emailVerificationExpires" = NULL
             WHERE "emailVerificationToken" IS NOT NULL
        `);
        await queryRunner.query(`
            UPDATE "users"
               SET "passwordResetToken" = NULL,
                   "passwordResetExpires" = NULL
             WHERE "passwordResetToken" IS NOT NULL
        `);
    }

    public async down(): Promise<void> {
        // Irreversible by design. There is no plaintext to restore to; the
        // values were nulled. Operators who need to re-issue specific tokens
        // can use the normal "resend verification email" / "forgot password"
        // flows.
    }
}
