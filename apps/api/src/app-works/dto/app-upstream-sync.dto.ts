import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';
import type { AppUpstreamSyncRequest } from '@ever-works/contracts';

/**
 * APW-02 T46 — the body of `POST /api/works/:id/upstream/sync`.
 *
 * Both fields are optional, so the empty body every existing caller sends (`{}`) is
 * still **Sync now**, unchanged. The global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so anything else in the body is refused `400`.
 */
export class AppUpstreamSyncDto implements AppUpstreamSyncRequest {
    @ApiPropertyOptional({
        description:
            '`true` ⇒ the Work owner accepts the held range’s workflow changes ("Sync anyway"). Owner only, from a signed-in session only.',
    })
    @IsOptional()
    @IsBoolean()
    confirmWorkflowChanges?: boolean;

    @ApiPropertyOptional({
        description:
            'The held upstream head the owner reviewed (a 7–40 character hex sha). A different hold on record answers `409 workflow_hold_changed`.',
    })
    @IsOptional()
    @IsString()
    @Matches(/^[0-9a-fA-F]{7,40}$/)
    workflowHeadSha?: string;
}
