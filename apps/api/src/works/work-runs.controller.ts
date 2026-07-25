import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AgentRunRepository } from '@ever-works/agent/agents';
import { WorkOwnershipService } from '@ever-works/agent/services';
import { CurrentUser } from '../auth/decorators/user.decorator';
import type { AuthenticatedUser } from '../auth/types/auth.types';

/**
 * Run orchestration (Wave 4 M3) — per-Work session summary chips.
 *
 *   GET /api/works/:id/runs-summary → { running, queued, awaiting, failedLast24h }
 *
 * One grouped query over the `(workId, status)` index — the Work-detail
 * header polls this, so it must stay a single cheap scan.
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
        summary: 'Per-Work AgentRun summary counts (running / queued / awaiting / failedLast24h).',
    })
    @HttpCode(HttpStatus.OK)
    async runsSummary(
        @CurrentUser() auth: AuthenticatedUser,
        @Param('id', ParseUUIDPipe) id: string,
    ): Promise<{ running: number; queued: number; awaiting: number; failedLast24h: number }> {
        await this.ownership.ensureAccess(id, auth.userId);
        return this.agentRuns.summarizeForWork(id);
    }
}
