import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * H-17 (rest) — per-user login lockout columns.
 *
 * Batch 2/3 of the audit fixes landed the per-IP `@Throttle` on
 * `/auth/login`. That covers a noisy attacker hammering one IP, but an
 * attacker rotating IPs to credential-stuff a single account walks right
 * past it. This migration adds the two columns the application needs to
 * lock the *account* after `LOGIN_LOCKOUT_THRESHOLD` consecutive failed
 * verifies, for `LOGIN_LOCKOUT_DURATION_MS` afterwards.
 *
 *   - `failedLoginAttempts` (int, default 0) — monotonically increases on
 *     each failed signInEmail and resets to 0 on the first successful one.
 *   - `lockedUntil` (timestamp, nullable) — set to `now + duration` when
 *     `failedLoginAttempts` crosses the threshold. Cleared back to NULL on
 *     successful login.
 *
 * Both columns get safe defaults so existing rows pick up the new shape
 * without an explicit backfill.
 */
export class AddLoginLockoutH17_1779400000000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            'users',
            new TableColumn({
                name: 'failedLoginAttempts',
                type: 'int',
                default: 0,
                isNullable: false,
            }),
        );

        await queryRunner.addColumn(
            'users',
            new TableColumn({
                name: 'lockedUntil',
                type: 'timestamp',
                isNullable: true,
            }),
        );
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn('users', 'lockedUntil');
        await queryRunner.dropColumn('users', 'failedLoginAttempts');
    }
}
