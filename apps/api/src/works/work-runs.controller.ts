import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentRunRepository, type WorkRunsSummary } from '@ever-works/agent/agents';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Run orchestration (Wave 4 M3) — per-Work session summary chips, plus
 * the M7 spend rollup.
 *
 *   GET /api/works/:id/runs-summary →
 *     { running, queued, awaiting, failedLast24h,          // M3 counts
 *       needsAttention,                                     // M6 badge
 *       costCentsTotal, costCentsLast24h,                   // M7 spend
 *       totalTokens, totalTokensLast24h }
 *
 * ONE grouped query over the `(workId, status)` index — the Work-detail
 * header polls this, so it must stay a single cheap scan. The spend
 * columns ride the same scan precisely so "how much is this Work costing
 * me?" does not become a second round trip (or a join to
 * `plugin_usage_events`): `agent_runs.costCents` is already the settled
 * per-run rollup.
 *
 * The widening is ADDITIVE — the four original count fields keep their
 * names and meanings, so a client reading only those is unaffected.
 *
 * Security: `WorkOwnershipService.ensureAccess` gates the Work first —
 * cross-user Works 404 with no existence leak (architecture/security §9).
 * The counts that follow are intentionally Work-scoped, not user-scoped:
 * a Work's fleet summary covers every member's runs on that Work, which
 * is exactly what the per-Work cockpit shows.
 */
@ApiTags('works')
@Controller('api')
export class WorkRunsController {
    constructor(
        private readonly ownership: WorkOwnershipService,
        private readonly agentRuns: AgentRunRepository,
    ) {}

    @Get('works/:id/runs-summary')
    @ApiOperation({
        summary:
            'Per-Work AgentRun summary: counts (running / queued / awaiting / failedLast24h / needsAttention) plus the spend + token rollup.',
    })
    @HttpCode(HttpStatus.OK)
    async runsSummary(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<WorkRunsSummary> {
        await this.ownership.ensureAccess(id, auth.userId);
        return this.agentRuns.summarizeForWork(id);
    }
}
