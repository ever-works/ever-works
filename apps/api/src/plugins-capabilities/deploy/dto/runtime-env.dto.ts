import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsIn,
    IsNotEmpty,
    IsObject,
    IsOptional,
    IsString,
    Matches,
    ValidateIf,
} from 'class-validator';

export const DATABASE_MODES = ['shared', 'custom'] as const;
export type DatabaseMode = (typeof DATABASE_MODES)[number];

/**
 * Body for `PUT /api/deploy/works/:id/runtime-env`.
 *
 * Two independent concerns share this endpoint; either (or both) may be sent:
 *
 * **Database** — `mode` selects where the Work's site DATABASE_URL comes from:
 *  - `'shared'` — the platform-managed **Ever Works DB**. No `databaseUrl` is
 *    required; the platform auto-provisions a per-Work database and injects it
 *    on the next deploy.
 *  - `'custom'` — a bring-your-own Postgres connection string, supplied in
 *    `databaseUrl`. This is the pre-existing behaviour.
 *
 * `mode` is optional for backward-compatibility: a body with only `databaseUrl`
 * is treated as `'custom'` (the old contract). When the database section is
 * being applied and `mode !== 'shared'` the connection string is required and
 * must be a `postgres(ql)://` URL.
 *
 * **Per-Work env** — `env` is a merge-patch over the allow-listed runtime env
 * map (Stripe keys & co., see `WORK_RUNTIME_ENV_ALLOWED_KEYS`): provided keys
 * overwrite, `null` / empty string removes, omitted keys are untouched. Keys
 * outside the allow-list are rejected with 400 by the service. A body with
 * ONLY `env` leaves the database mode/URL untouched.
 */
export class SetRuntimeEnvDto {
    @ApiPropertyOptional({
        description: "Where the Work's DATABASE_URL comes from.",
        enum: DATABASE_MODES,
        example: 'shared',
    })
    @IsOptional()
    @IsIn(DATABASE_MODES, { message: "mode must be 'shared' or 'custom'" })
    mode?: DatabaseMode;

    @ApiPropertyOptional({
        description:
            'Postgres connection string used as the Work site DATABASE_URL. Required for custom mode; ignored for shared mode.',
        example: 'postgresql://user:password@your-db-host:5432/dbname?sslmode=require',
    })
    // Required whenever the database section is being applied: an explicit
    // `mode: 'custom'`, a `databaseUrl` of any shape, or the legacy bare body
    // (neither `mode` nor `env` present). A body carrying only `env` skips it.
    @ValidateIf(
        (o) =>
            o.mode === 'custom' ||
            o.databaseUrl !== undefined ||
            (o.mode === undefined && o.env === undefined),
    )
    @IsString()
    @IsNotEmpty()
    @Matches(/^postgres(ql)?:\/\/.+/i, {
        message: 'databaseUrl must be a postgres:// or postgresql:// connection string',
    })
    databaseUrl?: string;

    @ApiPropertyOptional({
        description:
            'Merge-patch over the allow-listed per-Work runtime env (e.g. STRIPE_SECRET_KEY). Provided keys overwrite; null or empty string removes; omitted keys are untouched. Keys outside the allow-list are rejected (400).',
        type: 'object',
        additionalProperties: { type: 'string', nullable: true },
        example: { STRIPE_SECRET_KEY: 'sk_live_…', NEXT_PUBLIC_PAYMENT_PROVIDER: 'stripe' },
    })
    @IsOptional()
    @IsObject({ message: 'env must be an object of KEY: value pairs' })
    env?: Record<string, string | null>;
}

/**
 * Body for `POST /api/deploy/works/:id/db/test` — validate a custom Postgres
 * connection string before saving it.
 */
export class TestDbConnectionDto {
    @ApiPropertyOptional({
        description: 'Postgres connection string to test.',
        example: 'postgresql://user:password@your-db-host:5432/dbname?sslmode=require',
    })
    @IsString()
    @IsNotEmpty()
    @Matches(/^postgres(ql)?:\/\/.+/i, {
        message: 'databaseUrl must be a postgres:// or postgresql:// connection string',
    })
    databaseUrl!: string;
}
