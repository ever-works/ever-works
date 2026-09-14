import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { RunKnowledgeCitation, RunReceipt } from '@ever-works/contracts';
import { AgentRunRepository } from '../database/repositories/agent-run.repository';
import { AgentRunLogRepository } from '../database/repositories/agent-run-log.repository';
import { WorkKnowledgeCitationRepository } from '../database/repositories/work-knowledge-citation.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import { KbCitationConsumerType } from '../entities/kb-types';
import { AgentsService } from './agents.service';
import {
    RUN_COST_BREAKDOWN_READER,
    type RunCostBreakdownReader,
} from './run-cost-breakdown-reader';
import { RunLedgerService } from './run-ledger.service';

/**
 * Step names the receipt counts are composed from — the same literals the
 * run capture writes and the session-detail endpoint counts, so the receipt
 * and the session page report identical numbers for one run.
 */
const MESSAGE_STEPS = ['assistant-message', 'user-message'] as const;
const TOOL_STEPS = ['tool-invocation'] as const;
const CAPTURE_TRUNCATED_STEPS = ['capture-truncated'] as const;

/**
 * Run receipt (AW-09) — the itemised, after-the-fact account of ONE run:
 * its ledger row, what it cost, what it touched, and which Knowledge Base
 * documents it cited.
 *
 * A projection, never a stored record. It reads the run under the viewer's
 * ownership scope, then composes existing reads: the ledger row mapping,
 * the session capture counts, the Costs dashboard's per-run breakdown and
 * the KB citation trail recorded against the run.
 *
 * A run the viewer cannot read and a run that does not exist both resolve
 * to `null` — the endpoint turns both into the same 404, so the receipt is
 * never an existence oracle.
 */
@Injectable()
export class RunReceiptService {
    constructor(
        private readonly runs: AgentRunRepository,
        private readonly runLogs: AgentRunLogRepository,
        private readonly ledger: RunLedgerService,
        private readonly agents: AgentsService,
        private readonly citations: WorkKnowledgeCitationRepository,
        // Bound api-side to CostsSummaryService — the Costs dashboard's own
        // producer — so the two surfaces share one source of cost figures.
        @Inject(RUN_COST_BREAKDOWN_READER) private readonly costs: RunCostBreakdownReader,
    ) {}

    async getReceipt(
        userId: string,
        runId: string,
        ownershipScope?: OwnershipScope,
        now: Date = new Date(),
    ): Promise<RunReceipt | null> {
        const run = ownershipScope
            ? await this.runs.findByIdAndUser(runId, userId, ownershipScope)
            : await this.runs.findByIdAndUser(runId, userId);
        if (!run) return null;

        // Same second gate the session-detail endpoint applies: the run's
        // Agent must be visible in this scope too.
        try {
            await this.agents.getOne(userId, run.agentId, ownershipScope);
        } catch (error) {
            if (error instanceof NotFoundException) return null;
            throw error;
        }

        const [[row], cost, messages, toolCalls, truncatedMarkers, citations] = await Promise.all([
            this.ledger.toRows([run]),
            this.costs.getRunCostBreakdown(run, now),
            this.runLogs.countByRunSteps(run.id, MESSAGE_STEPS),
            this.runLogs.countByRunSteps(run.id, TOOL_STEPS),
            this.runLogs.countByRunSteps(run.id, CAPTURE_TRUNCATED_STEPS),
            this.citations.listForConsumer(KbCitationConsumerType.AGENT_RUN, run.id),
        ]);

        const filesTouched = (run.workspaceMeta?.filesTouched ?? []).filter(
            (path): path is string => typeof path === 'string' && path.length > 0,
        );

        return {
            row,
            cost,
            counts: {
                messages,
                toolCalls,
                // Explicit capture wins; the workspace diff rollup is the
                // fallback — the same rule the session page uses.
                filesTouched:
                    filesTouched.length > 0 ? filesTouched.length : (run.changedFilesCount ?? 0),
            },
            filesTouched,
            captureTruncated: truncatedMarkers > 0,
            knowledge: citations.map(
                (citation): RunKnowledgeCitation => ({
                    documentId: citation.documentId,
                    workId: citation.workId,
                    relevanceScore: citation.relevanceScore ?? null,
                    citedAt: new Date(citation.createdAt).toISOString(),
                }),
            ),
        };
    }
}
