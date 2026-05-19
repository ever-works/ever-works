import {
    Controller,
    ForbiddenException,
    HttpCode,
    HttpException,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@src/auth/decorators/user.decorator';
import type { AuthenticatedUser } from '@src/auth/types/auth.types';
import { WorkRepository } from '@ever-works/agent/database';
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
    constructor(
        private readonly dataSyncService: DataSyncService,
        private readonly workRepository: WorkRepository,
    ) {}

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
        // Per-Work ownership / access check. The service docstring
        // promises this check lives "alongside the gate body" inside
        // `runDataSync`, but the gate body is still stubbed — so a
        // stranger probing this endpoint would otherwise get a 2xx
        // `enqueued` envelope and reveal that the Work exists. Gate at
        // the controller until the service-level check lands.
        const work = await this.workRepository.findById(id);
        if (!work) {
            throw new NotFoundException({ status: 'error', message: 'Work not found' });
        }
        if (work.userId !== auth.userId) {
            throw new ForbiddenException({
                status: 'error',
                message: 'You do not have permission to sync this work',
            });
        }
        // The service still throws plain `Error: not yet implemented` for
        // some code paths (and the per-Work ownership check is still
        // marked TODO inside `runDataSync`). Convert anything that isn't
        // already an HttpException into a 404 so the manual escape valve
        // never leaks a raw 500. Once the service-level check lands this
        // catch can be removed.
        try {
            const outcome = await this.dataSyncService.runDataSync(id, 'manual');
            return shapeOutcome(outcome);
        } catch (error) {
            if (error instanceof HttpException) throw error;
            throw new NotFoundException({
                status: 'error',
                message: 'Work not found or data-sync is not available for this work',
            });
        }
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
