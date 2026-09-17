import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Workspace backup (AW-22) — the body of `POST /api/account/backups`.
 *
 * A class rather than an interface on purpose. The existing export/import
 * bodies on `account.controller.ts` are erased TypeScript interfaces, which
 * is exactly why that controller carries hand-rolled size caps: the global
 * `ValidationPipe` only enforces constraints on decorated classes, so an
 * interface-typed body reaches the service unchecked. Everything new on this
 * surface is a class so the pipe actually applies.
 */
export class CreateBackupDto {
    /**
     * Spec FR-7 — lift the trim windows to the three-year ceiling. Larger
     * file, slower to build; the card says so before the owner confirms.
     */
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => (typeof value === 'string' ? value === 'true' : value))
    includeFullHistory?: boolean;
}
