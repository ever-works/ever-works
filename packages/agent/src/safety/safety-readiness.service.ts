import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, In, Not, Repository } from 'typeorm';
import {
    READINESS_WINDOW_DAYS,
    type LadderedActionCategory,
    type ReadinessDecisionSample,
    type ReadinessDto,
    type ResolvedLadder,
    type TrustRung,
} from '@ever-works/contracts';
import { AgentActionProposal } from '../entities/agent-action-proposal.entity';
import { PROPOSAL_ACTION_CATEGORY } from './guardrail-interop';
import { computeReadiness } from './readiness';
import { RailRefusalRepository } from './rail-refusal.repository';

/**
 * Safety rails (AW-24) — the IO half of readiness.
 *
 * The arithmetic lives in `readiness.ts` (pure, thresholds pinned at their
 * boundaries by its own spec). This service is only the two reads it needs:
 * the answered decisions in the window, and the refusals by any rail OTHER
 * than the ladder.
 *
 * ## Why it reads proposals rather than a new table
 *
 * A decision is a projection over the approval queue, not a noun of its own.
 * Readiness counts what a person actually answered, so `agent_action_proposals`
 * — the durable decision record this platform already keeps — is the source.
 * The projection down to four fields happens here, so nothing downstream can
 * see a payload.
 *
 * ## `withdrawn` is structurally zero in P1
 *
 * The proposal status enum is `pending | approved | rejected`; there is no
 * withdrawal today. The field is still computed and still gates readiness,
 * so the day a withdrawal exists it counts without a second change here.
 *
 * Never throws: readiness is advisory, and a screen that cannot say "ready"
 * is strictly better than a screen that cannot load.
 */
@Injectable()
export class SafetyReadinessService {
    private readonly logger = new Logger(SafetyReadinessService.name);

    constructor(
        @InjectRepository(AgentActionProposal)
        private readonly proposals: Repository<AgentActionProposal>,
        private readonly refusals: RailRefusalRepository,
    ) {}

    /** Readiness per category, over the trailing window. */
    async forWorkspace(userId: string, ladder: ResolvedLadder): Promise<ReadinessDto[]> {
        const now = new Date();
        const from = new Date(now.getTime() - READINESS_WINDOW_DAYS * 24 * 60 * 60 * 1000);

        const [decisions, otherRefusalsByCategory] = await Promise.all([
            this.loadDecisions(userId, from, now),
            this.loadOtherRefusals(userId, from, now),
        ]);

        const currentRungs: Partial<Record<LadderedActionCategory, TrustRung>> = {};
        for (const entry of ladder.entries) currentRungs[entry.category] = entry.rung;

        return computeReadiness({ decisions, otherRefusalsByCategory, currentRungs, now });
    }

    private async loadDecisions(
        userId: string,
        from: Date,
        to: Date,
    ): Promise<ReadinessDecisionSample[]> {
        let rows: AgentActionProposal[];
        try {
            rows = await this.proposals.find({
                where: {
                    userId,
                    status: In(['approved', 'rejected']),
                    decidedAt: Between(from, to),
                    actionType: Not(In(['other'])),
                },
                select: { actionType: true, status: true, decidedAt: true },
            });
        } catch (error) {
            this.logger.warn(
                `Readiness could not read the decision record for user ${userId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return [];
        }

        const samples: ReadinessDecisionSample[] = [];
        for (const row of rows) {
            const category = PROPOSAL_ACTION_CATEGORY[row.actionType];
            // An action type nothing classifies contributes to no category's
            // record, rather than being counted somewhere plausible.
            if (!category || !row.decidedAt) continue;
            samples.push({
                category,
                outcome: row.status === 'approved' ? 'approved' : 'rejected',
                decidedAt: row.decidedAt,
            });
        }
        return samples;
    }

    private async loadOtherRefusals(
        userId: string,
        from: Date,
        to: Date,
    ): Promise<Partial<Record<LadderedActionCategory, number>>> {
        const counts: Partial<Record<LadderedActionCategory, number>> = {};
        let rows: Awaited<ReturnType<RailRefusalRepository['findInWindow']>>;
        try {
            rows = await this.refusals.findInWindow(userId, from, to);
        } catch (error) {
            this.logger.warn(
                `Readiness could not read the refusal log for user ${userId}: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return counts;
        }
        for (const row of rows) {
            // "No OTHER rail refused anything in it" — the ladder's own holds
            // are the record readiness is measuring, not evidence against it.
            if (row.railId === 'ladder' || !row.category) continue;
            const category = row.category as LadderedActionCategory;
            counts[category] = (counts[category] ?? 0) + 1;
        }
        return counts;
    }
}
