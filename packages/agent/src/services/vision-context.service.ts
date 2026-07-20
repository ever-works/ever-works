import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../entities/user.entity';
import { Organization } from '../entities/organization.entity';

/**
 * PR-6 (domain-model evolution, review §23.5) — hard cap on the vision
 * text injected into prompts. The Organization column itself allows up
 * to 5000 chars (see `OrganizationService.normalizeVision` in
 * apps/api); prompt surfaces get the tighter ~2000-char slice so a
 * long vision can never crowd out the actual task context.
 */
export const VISION_PROMPT_MAX_CHARS = 2000;

/**
 * PR-6 (domain-model evolution, review §23.5) — resolves the company
 * vision text to inject into prompt surfaces:
 *
 *   (a) Idea generation (`WorkProposalService.generate` →
 *       `buildProposalsPrompt`'s `<untrusted_company_vision>` block),
 *   (b) Agent-run prompt assembly (`AgentRunService.execute` appends a
 *       fenced "Company vision (untrusted user content)" segment), and
 *   (c) Mission tick context — no dedicated wiring: the tick worker
 *       (`MissionTickService.evaluateAndRun`) drives generation through
 *       `WorkProposalService.generate`, so it inherits path (a).
 *
 * Resolution rule (operator ruling): a user's "active" Organization is
 * `users.lastScopeOrganizationId`. When that is NULL — or the Org row
 * is missing, or its `vision` is NULL/blank — there is NO vision
 * context and this service returns `null`. Vision is a plain field
 * (not a versioned entity), so this is a straight two-hop read.
 *
 * Best-effort by design: vision is flavoring, never load-bearing.
 * Every failure path (missing rows, DB errors) degrades to `null`
 * rather than throwing, so a broken lookup can never take down Idea
 * generation or an Agent run. Callers inject the service `@Optional()`
 * for the same reason — hand-rolled unit-test constructors that omit
 * it keep working.
 */
@Injectable()
export class VisionContextService {
    private readonly logger = new Logger(VisionContextService.name);

    constructor(
        @InjectRepository(User)
        private readonly users: Repository<User>,
        @InjectRepository(Organization)
        private readonly organizations: Repository<Organization>,
    ) {}

    /**
     * Resolve the vision text for a user's active Organization.
     * Returns the trimmed vision capped at `VISION_PROMPT_MAX_CHARS`,
     * or `null` when the user has no active Org scope / the Org has no
     * vision / any lookup fails.
     *
     * NOTE: callers are responsible for FENCING the returned text as
     * untrusted user content before interpolating it into a prompt —
     * see `buildProposalsPrompt` (prompts.ts) and
     * `AgentRunService.execute` for the house `<untrusted_*>` pattern.
     */
    async resolveForUser(userId: string): Promise<string | null> {
        if (!userId) {
            return null;
        }
        try {
            const user = await this.users.findOne({ where: { id: userId } });
            if (!user || !user.lastScopeOrganizationId) {
                // No active Org scope → no vision context (ruling).
                return null;
            }
            const org = await this.organizations.findOne({
                where: { id: user.lastScopeOrganizationId },
            });
            const vision = org?.vision?.trim();
            if (!vision) {
                return null;
            }
            return vision.length > VISION_PROMPT_MAX_CHARS
                ? vision.slice(0, VISION_PROMPT_MAX_CHARS)
                : vision;
        } catch (err) {
            // Best-effort: a vision lookup failure must never break the
            // caller's prompt path — log and degrade to "no vision".
            this.logger.warn(
                `VisionContextService.resolveForUser failed for user ${userId}: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            );
            return null;
        }
    }
}
