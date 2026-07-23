import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, Matches, ValidateIf } from 'class-validator';

export const DATABASE_MODES = ['shared', 'custom'] as const;
export type DatabaseMode = (typeof DATABASE_MODES)[number];

/**
 * Body for `PUT /api/deploy/works/:id/runtime-env`.
 *
 * `mode` selects where the Work's site DATABASE_URL comes from:
 *  - `'shared'` — the platform-managed **Ever Works DB**. No `databaseUrl` is
 *    required; the platform auto-provisions a per-Work database and injects it
 *    on the next deploy.
 *  - `'custom'` — a bring-your-own Postgres connection string, supplied in
 *    `databaseUrl`. This is the pre-existing behaviour.
 *
 * `mode` is optional for backward-compatibility: a body with only `databaseUrl`
 * is treated as `'custom'` (the old contract). When `mode !== 'shared'` the
 * connection string is required and must be a `postgres(ql)://` URL.
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
    @ValidateIf((o) => o.mode !== 'shared')
    @IsString()
    @IsNotEmpty()
    @Matches(/^postgres(ql)?:\/\/.+/i, {
        message: 'databaseUrl must be a postgres:// or postgresql:// connection string',
    })
    databaseUrl?: string;
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
