import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * Body for `PUT /api/deploy/works/:id/runtime-env`.
 *
 * Sets the per-Work `DATABASE_URL` — the one piece of deploy runtime env that
 * is NOT auto-generated (unlike `AUTH_SECRET` / `COOKIE_SECRET`, which the deploy
 * feature mints and rotates itself). On Vercel this was injected by the Neon
 * Marketplace integration; on k8s the operator/owner supplies it here so it can
 * be seen and edited from the platform rather than set out-of-band.
 */
export class SetRuntimeEnvDto {
    @ApiProperty({
        description: 'Postgres connection string used as the Work site DATABASE_URL',
        example: 'postgresql://user:password@host.neon.tech/dbname?sslmode=require',
    })
    @IsString()
    @IsNotEmpty()
    @Matches(/^postgres(ql)?:\/\/.+/i, {
        message: 'databaseUrl must be a postgres:// or postgresql:// connection string',
    })
    databaseUrl!: string;
}
