import { Injectable, Logger } from '@nestjs/common';
import { AiFacadeService } from '../facades/ai.facade';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { WorkProposalRepository } from './work-proposal.repository';
import { permissiveWorkProposalsBatchSchema, type WorkProposalDraft } from './schemas';
import { coerceWorkProposal } from './proposal-coercion';
import {
    PROPOSALS_SYSTEM_PROMPT,
    buildProposalsPrompt,
    type ExistingIdeaContext,
    type MissionContext,
} from './prompts';
import { classifyIdeaFailure, computeBackoffSeconds, isTransient } from './idea-failure-classifier';
import { IdeaFailureKind } from '../entities/work-proposal.entity';
import { TitlerService } from '../titler/titler.service';

/**
 * Output of `handleGoalCompletion` — the decision the
 * goal-completion handler made about what to do with the Idea.
 * Callers (the future goal-execution path) use this to either
 * schedule the next retry (in `retry`-outcome) or just record the
 * terminal state.
 *
 * Phase 1 PR FF / spec §3.9 / Decision A23.
 */
export type GoalCompletionDecision =
    | { outcome: 'accepted'; ideaId: string; workId: string }
    | { outcome: 'rebuild-accepted'; ideaId: string; workId: string; previousWorkId: string | null }
    | {
          outcome: 'retry';
          ideaId: string;
          attempts: number;
          retryDelaySeconds: number;
          kind: IdeaFailureKind;
      }
    | { outcome: 'failed'; ideaId: string; kind: IdeaFailureKind; message: string }
    | { outcome: 'noop'; reason: string };

/**
 * Auto-retry policy snapshot passed to `handleGoalCompletion` by
 * the caller. Read from `WorkAgentPreference` columns added in
 * Phase 0 PR 0.5 (`maxAutoRetries`, `backoffSeconds`,
 * `exponentialBackoffFactor`).
 */
export interface AutoRetryPolicy {
    maxAutoRetries: number;
    backoffSeconds: number;
    exponentialBackoffFactor: number;
}

/** Best-effort extraction of a human-readable message from an
 *  unknown error value. Mirrors the classifier's input shape (Error
 *  / string / object-with-message), trimmed and bounded so the
 *  Idea Card UI can render it inline without overflow. */
function extractFailureMessage(input: unknown): string {
    if (typeof input === 'string') return input.trim() || 'Unknown failure';
    if (input instanceof Error) return (input.message || 'Unknown failure').trim();
    if (input && typeof input === 'object') {
        const m = (input as Record<string, unknown>).message;
        if (typeof m === 'string' && m.trim().length > 0) return m.trim();
    }
    return 'Unknown failure';
}
import { resolveAiProviderForResearch } from './provider-resolver';
import {
    WorkProposalStatus,
    type WorkProposal,
    type WorkProposalSource,
} from '../entities/work-proposal.entity';

export interface GenerateProposalsResult {
    status: 'generated' | 'skipped-no-profile' | 'skipped-low-confidence' | 'error';
    proposals: WorkProposal[];
    tokensUsed: number;
    error?: string;
}

export interface GenerateProposalsOptions {
    source: WorkProposalSource;
    generationRunId?: string;
    /** Suppress generation when confidence is 'low'. Default true. */
    suppressLowConfidence?: boolean;
    /**
     * Phase 1 PR D — number of Ideas to ask the model for. Caller
     * (WorkProposalsApiService) passes `user.autoGenerateBatchSize`
     * (Phase 0 PR 0.4 column). When omitted / null the prompt
     * builder applies its own hardcoded default
     * (DEFAULT_PROPOSALS_PER_TICK = 3). Clamped to 1-20.
     */
    targetCount?: number | null;
    /**
     * Phase 3 PR J — Mission-scoped generation context. When set,
     * the prompt asks the model to bias every generated Idea
     * toward the Mission's Goal description (and KB excerpts when
     * supplied). Spawned Ideas should be persisted with
     * `missionId = <mission.id>` by the caller (Mission tick
     * worker), so this option carries the prompt-side payload
     * separate from the FK-side wiring.
     */
    missionContext?: MissionContext;
    /**
     * Phase 1 PR C — when set, the FK on every persisted Idea
     * gets this value (`source = MISSION` callers pass this so
     * the Idea is back-linked to the spawning Mission).
     */
    missionId?: string;
}

@Injectable()
export class WorkProposalService {
    private readonly logger = new Logger(WorkProposalService.name);

    constructor(
        private readonly users: UserRepository,
        private readonly works: WorkRepository,
        private readonly registry: PluginRegistryService,
        private readonly aiFacade: AiFacadeService,
        private readonly repo: WorkProposalRepository,
        // Phase 3 PR I — shared titler service. Replaces the inline
        // `deriveTitle` placeholder from Phase 1 PR B with a real
        // service that future PRs can swap to an AI-backed impl
        // without touching this call site.
        private readonly titler: TitlerService,
    ) {}

    async generate(
        userId: string,
        opts: GenerateProposalsOptions,
    ): Promise<GenerateProposalsResult> {
        const user = await this.users.findById(userId);
        if (!user) {
            return { status: 'error', proposals: [], tokensUsed: 0, error: 'user-not-found' };
        }

        const profile = user.inferredInterests;
        if (!profile) {
            return { status: 'skipped-no-profile', proposals: [], tokensUsed: 0 };
        }

        const suppress = opts.suppressLowConfidence ?? true;
        if (suppress && profile.confidence === 'low') {
            this.logger.log(`Skipping proposal generation for ${userId}: confidence=low`);
            return { status: 'skipped-low-confidence', proposals: [], tokensUsed: 0 };
        }

        const existingWorks = await this.works.findByUser(userId).catch(() => []);
        const existingWorkNames = existingWorks.map((w) => w.name).slice(0, 20);

        const availablePluginIds = this.registry
            .getReady()
            .map((p) => p.plugin.id)
            .filter(Boolean);

        let providerName: string;
        let modelName: string;
        let providerId: string;
        try {
            const resolved = await resolveAiProviderForResearch(
                this.aiFacade,
                this.registry,
                userId,
                this.logger,
            );
            if (!resolved) {
                return {
                    status: 'error',
                    proposals: [],
                    tokensUsed: 0,
                    error: 'ai-provider-not-configured',
                };
            }
            providerId = resolved.providerId;
            providerName = resolved.providerName;
            modelName = resolved.modelName;
        } catch (err) {
            const message = (err as Error).message;
            this.logger.warn(`Provider resolution failed for ${userId}: ${message}`);
            return { status: 'error', proposals: [], tokensUsed: 0, error: message };
        }

        let tokensUsed = 0;
        let drafts: WorkProposalDraft[] = [];

        // Phase 1 PR C / spec §3.3 — fetch every existing Idea (across
        // all statuses incl. DONE / DISMISSED / FAILED) once, here, so:
        //   (a) buildProposalsPrompt can render them as exclusion +
        //       positive-context for the model, and
        //   (b) the post-coercion dedupe loop below can use the same
        //       set to filter out anything the model still produced
        //       that matches an existing slug/title (belt-and-braces).
        const existingProposals = await this.repo.findRecentByUser(userId).catch(() => []);
        const existingIdeasContext: ExistingIdeaContext[] = existingProposals.map((p) => ({
            title: p.title,
            slug: p.slugSuggestion,
            description: p.description,
            status: p.status,
        }));

        try {
            // Use the permissive schema so low-quality model output (sloppy
            // slugs, wrong enum values, off-by-one length bounds) doesn't
            // make JSON generation reject the whole batch. coerceWorkProposal
            // below clips/slugifies/filters each draft into the strict shape.
            const result = await this.aiFacade.askJson(
                [
                    PROPOSALS_SYSTEM_PROMPT,
                    buildProposalsPrompt(
                        profile,
                        existingWorkNames,
                        availablePluginIds,
                        existingIdeasContext,
                        opts.missionContext,
                        opts.targetCount ?? undefined,
                    ),
                ].join('\n\n'),
                permissiveWorkProposalsBatchSchema,
                {
                    temperature: 0.4,
                    routing: {
                        providerOverride: providerId,
                        modelOverride: modelName,
                    },
                },
                { userId },
            );

            const raw = result.result.proposals ?? [];
            drafts = raw
                .map((p) => coerceWorkProposal(p))
                .filter((p): p is WorkProposalDraft => p !== null);
            tokensUsed = result.usage?.totalTokens ?? 0;

            if (drafts.length === 0) {
                this.logger.warn(
                    `Proposal generation for ${userId} produced ${raw.length} raw draft(s) but none survived coercion`,
                );
                return {
                    status: 'error',
                    proposals: [],
                    tokensUsed,
                    error: 'no-valid-proposals',
                };
            }
            if (drafts.length < raw.length) {
                this.logger.log(
                    `Proposal generation for ${userId}: kept ${drafts.length}/${raw.length} after coercion`,
                );
            }
        } catch (err) {
            const message = (err as Error).message;
            this.logger.warn(`Proposal generation failed for ${userId}: ${message}`);
            return { status: 'error', proposals: [], tokensUsed, error: message };
        }

        // Drop plugin IDs the registry doesn't recognize. Casts mirror the
        // pre-coercion code — zod 3.25 widens inner-object props to optional
        // under our tsconfig, and the coercer already guarantees the shape.
        const pluginSet = new Set(availablePluginIds);
        const inputs = drafts.map((p) => ({
            userId,
            title: p.title,
            description: p.description,
            slugSuggestion: p.slugSuggestion,
            suggestedCategories: p.suggestedCategories as Array<{ name: string; slug: string }>,
            suggestedFields: p.suggestedFields as Array<{
                name: string;
                type: 'string' | 'url' | 'image' | 'number' | 'enum' | 'markdown';
            }>,
            recommendedPlugins: (
                p.recommendedPlugins as Array<{ pluginId: string; reason: string }>
            ).filter((rp) => pluginSet.has(rp.pluginId)),
            generatedPrompt: p.generatedPrompt,
            reasoning: p.reasoning,
            source: opts.source,
            generationRunId: opts.generationRunId,
            // Phase 1 PR C — Mission tick worker passes missionId so
            // the spawned Idea is back-linked to the originating
            // Mission. NULL for non-Mission sources.
            missionId: opts.missionId,
        }));

        const existingKeys = new Set(
            existingProposals.flatMap((proposal) => [
                this.proposalKey(proposal.slugSuggestion),
                this.proposalKey(proposal.title),
            ]),
        );
        const seenKeys = new Set<string>();
        const uniqueInputs = inputs.filter((proposal) => {
            const keys = [
                this.proposalKey(proposal.slugSuggestion),
                this.proposalKey(proposal.title),
            ];
            if (keys.some((key) => existingKeys.has(key) || seenKeys.has(key))) {
                return false;
            }
            keys.forEach((key) => seenKeys.add(key));
            return true;
        });

        if (uniqueInputs.length < inputs.length) {
            this.logger.log(
                `Proposal generation for ${userId}: skipped ${inputs.length - uniqueInputs.length} duplicate proposal(s)`,
            );
        }

        if (uniqueInputs.length === 0) {
            return { status: 'generated', proposals: [], tokensUsed };
        }

        const saved = await this.repo.bulkInsert(uniqueInputs);

        this.logger.log(
            `Generated ${saved.length} proposal(s) for ${userId} via "${providerName}" (${modelName}), tokens=${tokensUsed}`,
        );

        return { status: 'generated', proposals: saved, tokensUsed };
    }

    private proposalKey(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }

    async list(
        userId: string,
        statuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING],
        opts: { missionId?: string | null } = {},
    ) {
        return this.repo.findByUser(userId, statuses, opts);
    }

    async dismiss(userId: string, proposalId: string): Promise<boolean> {
        return this.repo.markDismissed(proposalId, userId);
    }

    async markAccepted(userId: string, proposalId: string, workId: string): Promise<boolean> {
        return this.repo.markAccepted(proposalId, userId, workId);
    }

    /**
     * Shared accept-flow helper called by BOTH the existing
     * `POST /me/work-proposals/:id/accept` controller (passing
     * `fromStatuses = [PENDING]`, preserving today's contract) AND
     * the Goal-completion handler (Phase 1 PR FF, passing
     * `fromStatuses = [BUILDING]`). PLAN Decision A3.
     *
     * Returns `false` when the proposal doesn't exist for this
     * user or is not currently in one of the allowed source
     * statuses (idempotent — re-acceptance is a no-op).
     */
    async acceptInternal(
        userId: string,
        proposalId: string,
        workId: string,
        fromStatuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING],
    ): Promise<boolean> {
        const proposal = await this.repo.findByIdForUser(proposalId, userId);
        if (!proposal) return false;
        return this.repo.markAccepted(proposalId, userId, workId, fromStatuses);
    }

    /**
     * Transition an Idea to QUEUED for build (Phase 1 PR B
     * `POST /me/work-proposals/:id/build`). Returns the freshly-
     * read Idea on success, `null` if the Idea doesn't exist for
     * the user or its status doesn't allow queuing.
     */
    async queueForBuild(userId: string, proposalId: string): Promise<WorkProposal | null> {
        const ok = await this.repo.markQueuedForBuild(proposalId, userId);
        if (!ok) return null;
        return this.repo.findByIdForUser(proposalId, userId);
    }

    /**
     * Create a user-typed Idea (`source = USER_MANUAL`, Phase 1
     * PR B `POST /me/work-proposals`). When the caller passes a
     * title, use it (clipped to the entity's varchar 120 limit).
     * When they don't, ask the shared TitlerService to derive one
     * from the description (Phase 3 PR I — replaces the inline
     * `deriveTitle` heuristic that lived here before).
     */
    async createUserManual(
        userId: string,
        input: { description: string; title?: string },
    ): Promise<WorkProposal> {
        const description = input.description.trim();
        const callerTitle = input.title?.trim();
        const title = callerTitle
            ? callerTitle.slice(0, 120)
            : (await this.titler.generateTitle(description, { kind: 'idea', userId })).slice(
                  0,
                  120,
              );
        const slugSuggestion = this.proposalKey(title).slice(0, 80) || 'untitled-idea';
        return this.repo.createUserManual({
            userId,
            title,
            description,
            slugSuggestion,
        });
    }

    // ─── Phase 1 PR FF — Retry, Re-build, and Goal-completion ─────

    /**
     * Re-queue a FAILED Idea for build (spec §3.9 manual Retry
     * button). Clears `failureMessage` + `failureKind`, transitions
     * FAILED → QUEUED. Same `markQueuedForBuild` repo method as the
     * regular build path uses (it already allows the FAILED source
     * status).
     *
     * Caller (`WorkProposalsApiService.retry`) is responsible for
     * also creating the new `WorkAgentGoal`. This service method
     * only owns the Idea-side state transition.
     */
    async retryFailed(userId: string, proposalId: string): Promise<WorkProposal | null> {
        const ok = await this.repo.markQueuedForBuild(proposalId, userId);
        if (!ok) return null;
        return this.repo.findByIdForUser(proposalId, userId);
    }

    /**
     * Transition an ACCEPTED Idea to BUILDING for the Re-build
     * flow (Decision A27). The Idea returns to ACCEPTED when the
     * new Goal completes, with `acceptedWorkId` re-pointed at the
     * NEW Work. The ORIGINAL Work is preserved (not deleted) —
     * the user can keep, repurpose, or manually delete it.
     */
    async beginRebuild(userId: string, proposalId: string): Promise<WorkProposal | null> {
        const ok = await this.repo.markRebuildingFromAccepted(proposalId, userId);
        if (!ok) return null;
        return this.repo.findByIdForUser(proposalId, userId);
    }

    /**
     * Phase 1 PR FF — pure decision API for the goal-completion
     * handler (spec §3.9, Decisions A23 + A24 + A27).
     *
     * Given a Goal outcome for an Idea-tagged Goal, decide:
     *   - accept the Idea with the new Work id (success path),
     *   - schedule a retry per the user's policy (transient failure
     *     with retry budget left),
     *   - mark the Idea FAILED (terminal failure),
     *   - or no-op (Idea isn't in a state we should touch).
     *
     * This method DOES write Idea state for the terminal outcomes
     * (`accepted`, `rebuild-accepted`, `failed`). It does NOT
     * actually schedule the retry — that's the caller's
     * responsibility, since the scheduling primitive depends on
     * the surrounding execution infra (Trigger.dev today, possibly
     * BullMQ later). The returned `retryDelaySeconds` is the
     * computed wait per spec §3.9; the caller passes it to
     * whichever scheduler is in scope.
     *
     * `attempts` is the count of attempts ALREADY made (i.e. the
     * Goal that just completed counts as 1). The auto-retry budget
     * check is `attempts < policy.maxAutoRetries`. Caller derives
     * `attempts` from `goalRepo.count({ where: { ideaId } })` — no
     * new column needed.
     */
    async handleGoalCompletion(input: {
        userId: string;
        ideaId: string;
        outcome: { kind: 'success'; workId: string } | { kind: 'failure'; error: unknown };
        attempts: number;
        policy: AutoRetryPolicy;
    }): Promise<GoalCompletionDecision> {
        const proposal = await this.repo.findByIdForUser(input.ideaId, input.userId);
        if (!proposal) {
            return { outcome: 'noop', reason: 'idea-not-found' };
        }

        if (input.outcome.kind === 'success') {
            const previousWorkId = proposal.acceptedWorkId ?? null;
            const ok = await this.repo.markAccepted(
                input.ideaId,
                input.userId,
                input.outcome.workId,
                [WorkProposalStatus.BUILDING],
            );
            if (!ok) {
                return { outcome: 'noop', reason: 'idea-not-in-building' };
            }
            // Re-build flow: previousWorkId was non-null before the
            // accept overwrote it. The Decision A27 "original Work
            // is NOT deleted" guarantee is enforced by the absence
            // of a delete call here — Work survives standalone.
            if (previousWorkId !== null) {
                return {
                    outcome: 'rebuild-accepted',
                    ideaId: input.ideaId,
                    workId: input.outcome.workId,
                    previousWorkId,
                };
            }
            return { outcome: 'accepted', ideaId: input.ideaId, workId: input.outcome.workId };
        }

        // Failure path.
        const kind = classifyIdeaFailure(input.outcome.error);
        const message = extractFailureMessage(input.outcome.error);

        if (isTransient(kind) && input.attempts < input.policy.maxAutoRetries) {
            const retryDelaySeconds = computeBackoffSeconds(
                input.policy.backoffSeconds,
                input.policy.exponentialBackoffFactor,
                input.attempts,
            );
            // Idea status STAYS at BUILDING across auto-retries
            // (Decision A24 — no flicker to FAILED then QUEUED).
            // We don't write to the Idea here; the caller schedules
            // the retry, then when the new Goal starts it calls
            // markBuilding (a no-op when already BUILDING).
            return {
                outcome: 'retry',
                ideaId: input.ideaId,
                attempts: input.attempts + 1,
                retryDelaySeconds,
                kind,
            };
        }

        // Terminal failure — either non-transient or retry budget
        // exhausted. Mark FAILED with the classified kind + message.
        await this.repo.markFailed(input.ideaId, input.userId, message, kind);
        return { outcome: 'failed', ideaId: input.ideaId, kind, message };
    }

    async getForUser(userId: string, proposalId: string) {
        return this.repo.findByIdForUser(proposalId, userId);
    }

    async countPending(userId: string): Promise<number> {
        return this.repo.countPendingByUser(userId);
    }
}
