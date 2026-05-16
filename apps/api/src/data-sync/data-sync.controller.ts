import { Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@src/auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/authenticated-user.type';
import { DataSyncService } from './data-sync.service';
import type { DataSyncOutcome } from './data-sync.types';

/**
 * Operator force-sync endpoint (EW-628 Phase 6).
 *
 * Spec: `docs/specs/features/data-repo-instant-sync/spec.md` AC-10.
 *
 * `POST /api/works/:id/sync` is the manual escape valve when an operator
 * wants to push the data-repo → main-repo render right now instead of
 * waiting for the next dispatcher tick. It surfaces the same three-gate
 * outcome the dispatcher would have produced (success / skipped /
 * failed), letting the caller act on the response without polling the
 * activity feed.
 *
 * Auth is inherited from the global JWT guard via `@CurrentUser()`,
 * matching `POST /api/works/:id/generate`. Work ownership / write-access
 * checks live inside `DataSyncService.runDataSync` once the gate body
 * lands — until then the controller delegates blindly and the service
 * stub throws `not yet implemented`.
 *
 * The response envelope is `{ status, ...details }`. `status: 'enqueued'`
 * means the sync run started (or queued for a worker); `'skipped'`
 * carries the gate reason (`retry-backoff` | `sync-in-progress` |
 * `generation-in-progress`); `'failed'` includes `errorClass` so the
 * caller can decide whether to retry.
 */
@ApiTags('data-sync')
@Controller()
export class DataSyncController {
    constructor(private readonly dataSyncService: DataSyncService) {}

    @Post('api/works/:id/sync')
    @HttpCode(HttpStatus.ACCEPTED)
    @ApiOperation({
        summary: 'Force a data-repo → main-repo sync run',
        description:
            'Manual escape valve that bypasses the dispatcher cadence. Returns the same three-gate outcome the dispatcher would have produced.',
    })
    @ApiParam({ name: 'id', description: 'Work ID' })
    @ApiResponse({ status: 202, description: 'Sync run accepted (or skipped with a reason)' })
    async forceSync(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id') id: string,
    ): Promise<ForceSyncResponse> {
        // Auth presence (`auth.userId`) is asserted by the global guard
        // before reaching here; the per-Work write-access check moves
        // into DataSyncService.runDataSync alongside the gate body so it
        // stays centralised between webhook / poll / manual paths.
        void auth;
        const outcome = await this.dataSyncService.runDataSync(id, 'manual');
        return shapeOutcome(outcome);
    }
}

/**
 * Public response envelope. Stable across status branches so frontend
 * components can switch on `status` without re-narrowing per branch.
 */
export type ForceSyncResponse =
    | { status: 'enqueued'; outcome: 'success'; stats: Record<string, unknown> }
    | { status: 'skipped'; reason: string }
    | { status: 'failed'; errorClass: string; errorTail: string };

const shapeOutcome = (outcome: DataSyncOutcome): ForceSyncResponse => {
    if (outcome.status === 'success') {
        return {
            status: 'enqueued',
            outcome: 'success',
            stats: outcome.stats as unknown as Record<string, unknown>,
        };
    }
    if (outcome.status === 'skipped') {
        return { status: 'skipped', reason: outcome.reason };
    }
    return { status: 'failed', errorClass: outcome.errorClass, errorTail: outcome.errorTail };
};
