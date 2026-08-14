import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { AiFacadeService } from '../facades/ai.facade';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { WorkProposalRepository } from './work-proposal.repository';
import { IdeaWorkRepository } from '../database/repositories/idea-work.repository';
import type { IdeaWorkKind } from '../entities/idea-work.entity';
import { WorkProposalAttachmentRepository } from '../database/repositories/attachment.repositories';
import { WorkProposalAttachment } from '../entities/work-proposal-attachment.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { UserUpload } from '../entities/user-upload.entity';
import { Agent, AgentStatus } from '../entities/agent.entity';
import { VisionContextService } from '../services/vision-context.service';

// Upload IDs are SHA-256 hex strings (the `id` field returned by
// POST /api/uploads/file). 64 lowercase hex chars — NOT UUID-shaped
// (Codex + Greptile P1 on PR #1044).
const SHA256_RE = /^[0-9a-f]{64}$/i;
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
    WorkProposalSource,
    type WorkProposal,
} from '../entities/work-proposal.entity';

/**
 * Why `WorkProposalService.delete` refused. Travels to the client in
 * the 409 body (`{ reason, count, message }`) so the confirm dialog can
 * name the blocker instead of showing a generic error.
 *
 * `linked-works` is no longer produced — linked Works stopped blocking
 * the delete (see `delete`). It is retained in the union, and its
 * translations are retained in the web app, so a newer web build talking
 * to an older API during a rolling deploy still renders the refusal it
 * gets instead of falling through to a missing i18n key.
 */
export type IdeaDeleteBlockedReason = 'build-in-flight' | 'linked-works' | 'idea-agents';

export interface GenerateProposalsResult {
    status:
        | 'generated'
        | 'skipped-no-profile'
        | 'skipped-low-confidence'
        | 'skipped-at-limit'
        | 'error';
    proposals: WorkProposal[];
    tokensUsed: number;
    error?: string;
}

export interface GenerateProposalsOptions {
    source: WorkProposalSource;
    generationRunId?: string;
    /** Suppress generation when confidence is 'low'. Default true. */
    suppressLowConfidence?: boolean;
    /** Maximum pending proposals a user can have. Default: WORK_PROPOSALS_MAX_PENDING or 6. */
    maxPendingProposals?: number;
    /**
     * Phase 1 PR D - number of Ideas to ask the model for. Caller
     * (WorkProposalsApiService) passes user.autoGenerateBatchSize.
     * When omitted / null the prompt builder applies its own default.
     * Clamped to 1-20 by the prompt builder.
     */
    targetCount?: number | null;
    /**
     * Phase 3 PR J - Mission-scoped generation context. When set,
     * the prompt asks the model to bias every generated Idea toward
     * the Mission's goal description and KB excerpts.
     */
    missionContext?: MissionContext;
    /**
     * Phase 1 PR C - when set, the FK on every persisted Idea gets
     * this value; MISSION callers pass this for the back-link.
     */
    missionId?: string;
}

export const DEFAULT_MAX_PENDING_WORK_PROPOSALS = 6;

const DUPLICATE_TITLE_OVERLAP_THRESHOLD = 0.8;
const DUPLICATE_TITLE_JACCARD_THRESHOLD = 0.5;
const STOP_WORDS = new Set(['a', 'an', 'and', 'for', 'from', 'in', 'of', 'the', 'to', 'with']);

function positiveIntegerFromEnv(key: string, fallback: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveMaxPendingProposals(override?: number): number {
    if (Number.isInteger(override) && override > 0) return override;
    return positiveIntegerFromEnv('WORK_PROPOSALS_MAX_PENDING', DEFAULT_MAX_PENDING_WORK_PROPOSALS);
}

interface ProposalFingerprint {
    key: string;
    tokens: Set<string>;
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
        private readonly ideaWorks: IdeaWorkRepository,
        // Phase 3 PR I — shared titler service. Replaces the inline
        // `deriveTitle` placeholder from Phase 1 PR B with a real
        // service that future PRs can swap to an AI-backed impl
        // without touching this call site.
        private readonly titler: TitlerService,
        // Idea (WorkProposal) attachments — `@Optional()` because
        // hand-rolled tests construct WorkProposalService without it.
        // Production DI provides it via UserResearchModule.
        @Optional()
        private readonly proposalAttachments?: WorkProposalAttachmentRepository,
        // Upload-ownership validation for addAttachment — `user_uploads` indexes
        // every upload by (userId, sha256). `@Optional()` so hand-rolled tests
        // skip; production/e2e DI provides it.
        @Optional()
        @InjectRepository(UserUpload)
        private readonly uploadsRepo?: Repository<UserUpload>,
        // PR-3 Idea lifecycle activity logging (mirrors MissionsService) +
        // Schedules P2 `idea_generated` coverage — same @Optional() service.
        // TRAILING `@Optional()` param: hand-rolled tests construct this
        // service positionally, so existing params must keep their order.
        // Best-effort at call sites - an activity failure never fails the op.
        @Optional()
        private readonly activityLog?: ActivityLogService,
        // PR-6 (review §23.5) — company-vision prompt context for
        // `generate()`. Trailing + `@Optional()` so hand-rolled test
        // constructors that omit it keep working; production DI provides
        // it via UserResearchModule. When absent (or when the user has
        // no active Org / no vision) generation proceeds vision-less.
        @Optional()
        private readonly visionContext?: VisionContextService,
        // Idea-scoped Agent guard for `delete()` — `agents.ideaId` has no
        // DB FK, so a hard delete must check for stragglers itself.
        // TRAILING + `@Optional()` for the same reason as the params
        // above: hand-rolled tests construct this service positionally.
        @Optional()
        @InjectRepository(Agent)
        private readonly agentsRepo?: Repository<Agent>,
    ) {}

    /**
     * PR-3 - best-effort Idea activity write (never fails the operation;
     * no-ops when the service isn't wired, e.g. hand-rolled tests).
     */
    private async recordIdeaActivity(
        userId: string,
        actionType: ActivityActionType,
        action: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId,
                actionType,
                action,
                status: ActivityStatus.COMPLETED,
                summary: `Idea ${action}`,
                details: details as Record<string, any>,
            });
        } catch (error) {
            this.logger.warn(
                `Failed to write idea activity (${actionType}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }

    /**
     * List the Upload edges attached to an Idea. Validates ownership
     * before reading.
     */
    async listAttachments(userId: string, proposalId: string): Promise<WorkProposalAttachment[]> {
        const proposal = await this.repo.findByIdForUser(proposalId, userId);
        if (!proposal) {
            throw new NotFoundException(`Idea not found`);
        }
        if (!this.proposalAttachments) return [];
        return this.proposalAttachments.findByWorkProposalId(proposalId);
    }

    /**
     * Attach an uploaded file to an Idea. Idempotent on the unique
     * (workProposalId, uploadId) index — see `MissionsService.addAttachment`.
     */
    async addAttachment(
        userId: string,
        proposalId: string,
        uploadId: string,
    ): Promise<WorkProposalAttachment> {
        const proposal = await this.repo.findByIdForUser(proposalId, userId);
        if (!proposal) {
            throw new NotFoundException(`Idea not found`);
        }
        if (!uploadId || !SHA256_RE.test(uploadId)) {
            throw new BadRequestException(`Invalid uploadId`);
        }
        // Security: the uploadId must reference a real upload owned by the
        // caller (404 — don't leak existence). Closes the dangling/foreign
        // attachment edge the hunt found.
        if (this.uploadsRepo) {
            const owned = await this.uploadsRepo.findOne({
                where: { sha256: uploadId.toLowerCase(), userId },
            });
            if (!owned) throw new NotFoundException(`Upload ${uploadId} not found.`);
        }
        if (!this.proposalAttachments) {
            throw new BadRequestException(
                `WorkProposalAttachmentRepository is not wired — attach the WorkProposalAttachment provider before calling addAttachment`,
            );
        }
        try {
            return await this.proposalAttachments.add(proposalId, uploadId);
        } catch (err) {
            if (err instanceof Error && /duplicate key|unique constraint/i.test(err.message)) {
                const existing = (
                    await this.proposalAttachments.findByWorkProposalId(proposalId)
                ).find((a) => a.uploadId === uploadId);
                if (existing) return existing;
            }
            throw err;
        }
    }

    /**
     * Detach an Upload from an Idea. Validates ownership of both the
     * Idea AND that the attachment row's `workProposalId` matches.
     */
    async removeAttachment(
        userId: string,
        proposalId: string,
        attachmentId: string,
    ): Promise<{ deleted: true }> {
        const proposal = await this.repo.findByIdForUser(proposalId, userId);
        if (!proposal) {
            throw new NotFoundException(`Idea not found`);
        }
        if (!this.proposalAttachments) {
            throw new NotFoundException(`Attachment not found`);
        }
        const row = await this.proposalAttachments.findOne(attachmentId);
        if (!row || row.workProposalId !== proposalId) {
            throw new NotFoundException(`Attachment not found`);
        }
        await this.proposalAttachments.remove(attachmentId);
        return { deleted: true };
    }

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

        const maxPendingProposals = resolveMaxPendingProposals(opts.maxPendingProposals);
        const pendingCount = await this.repo.countPendingByUser(userId).catch(() => 0);
        const availableSlots = Math.max(0, maxPendingProposals - pendingCount);
        if (availableSlots <= 0) {
            this.logger.log(
                `Skipping proposal generation for ${userId}: pending proposal limit reached (${pendingCount}/${maxPendingProposals})`,
            );
            return { status: 'skipped-at-limit', proposals: [], tokensUsed: 0 };
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

        // PR-6 (review §23.5) — resolve the active Organization's vision
        // (users.lastScopeOrganizationId → organizations.vision, trimmed
        // + capped by VisionContextService) so every generated Idea can
        // bias toward the company's long-term direction. Best-effort:
        // the service is @Optional() and resolveForUser degrades to null
        // internally, so vision can never block generation. This also
        // covers Mission-tick generation — MissionTickService drives
        // this same generate() path.
        const companyVision = this.visionContext
            ? await this.visionContext.resolveForUser(userId)
            : null;

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
                        companyVision,
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

        const existingFingerprints = existingProposals.flatMap((proposal) =>
            this.proposalFingerprints(proposal.slugSuggestion, proposal.title),
        );
        const seenFingerprints: ProposalFingerprint[] = [];
        const uniqueInputs = inputs.filter((proposal) => {
            const fingerprints = this.proposalFingerprints(proposal.slugSuggestion, proposal.title);
            if (
                fingerprints.some(
                    (fingerprint) =>
                        this.hasSimilarFingerprint(fingerprint, existingFingerprints) ||
                        this.hasSimilarFingerprint(fingerprint, seenFingerprints),
                )
            ) {
                return false;
            }
            seenFingerprints.push(...fingerprints);
            return true;
        });

        if (uniqueInputs.length < inputs.length) {
            this.logger.log(
                `Proposal generation for ${userId}: skipped ${inputs.length - uniqueInputs.length} duplicate proposal(s)`,
            );
        }

        const cappedInputs = uniqueInputs.slice(0, availableSlots);
        if (cappedInputs.length < uniqueInputs.length) {
            this.logger.log(
                `Proposal generation for ${userId}: capped ${uniqueInputs.length - cappedInputs.length} proposal(s) at pending limit ${maxPendingProposals}`,
            );
        }

        if (cappedInputs.length === 0) {
            return { status: 'generated', proposals: [], tokensUsed };
        }

        const saved = await this.repo.bulkInsert(cappedInputs);

        this.logger.log(
            `Generated ${saved.length} proposal(s) for ${userId} via "${providerName}" (${modelName}), tokens=${tokensUsed}`,
        );

        // ONE activity row per generation batch (not per Idea). PR-3's
        // recordIdeaActivity covers every source (incl. MISSION-sourced
        // scheduled ticks), subsuming the Schedules-P2 idea_generated intent.
        await this.recordIdeaActivity(userId, ActivityActionType.IDEA_GENERATED, 'generate', {
            count: saved.length,
            source: opts.source,
            missionId: opts.missionId ?? null,
        });

        return { status: 'generated', proposals: saved, tokensUsed };
    }

    private proposalKey(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');
    }

    private proposalFingerprints(slugSuggestion: string, title: string): ProposalFingerprint[] {
        const seen = new Set<string>();
        return [slugSuggestion, title]
            .map((value) => this.proposalKey(value))
            .filter((key) => key.length > 0)
            .filter((key) => {
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .map((key) => ({ key, tokens: this.proposalTokens(key) }));
    }

    private proposalTokens(key: string): Set<string> {
        return new Set(key.split('-').filter((token) => token && !STOP_WORDS.has(token)));
    }

    private hasSimilarFingerprint(
        candidate: ProposalFingerprint,
        existing: ProposalFingerprint[],
    ): boolean {
        return existing.some((fingerprint) => this.areSimilarFingerprints(candidate, fingerprint));
    }

    private areSimilarFingerprints(a: ProposalFingerprint, b: ProposalFingerprint): boolean {
        if (a.key === b.key) return true;

        const minTokenCount = Math.min(a.tokens.size, b.tokens.size);
        if (minTokenCount < 2) return false;

        if (a.key.includes(b.key) || b.key.includes(a.key)) return true;

        const intersection = [...a.tokens].filter((token) => b.tokens.has(token)).length;
        const union = new Set([...a.tokens, ...b.tokens]).size;
        const overlap = intersection / minTokenCount;
        const jaccard = intersection / union;

        return (
            overlap >= DUPLICATE_TITLE_OVERLAP_THRESHOLD &&
            jaccard >= DUPLICATE_TITLE_JACCARD_THRESHOLD
        );
    }

    async list(
        userId: string,
        statuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING],
        opts: { missionId?: string | null; search?: string; limit?: number; offset?: number } = {},
    ) {
        return this.repo.findByUser(userId, statuses, opts);
    }

    async dismiss(userId: string, proposalId: string): Promise<boolean> {
        const ok = await this.repo.markDismissed(proposalId, userId);
        if (ok) {
            await this.recordIdeaActivity(userId, ActivityActionType.IDEA_DISMISSED, 'dismiss', {
                proposalId,
            });
        }
        return ok;
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
     * Returns `false` only when the Idea doesn't exist for this user
     * or the supplied Work isn't theirs — i.e. the cases that are
     * genuinely "not found". A legal-but-refused STATUS transition no
     * longer fails the call: the Idea↔Work link is still recorded and
     * the call reports success, because the link (not the status) is
     * what "this Idea produced a Work" means. See `recordProvenance`.
     */
    async acceptInternal(
        userId: string,
        proposalId: string,
        workId: string,
        fromStatuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING],
        opts: { linkKind?: IdeaWorkKind } = {},
    ): Promise<boolean> {
        const proposal = await this.repo.findByIdForUser(proposalId, userId);
        if (!proposal) return false;
        // Security (IDOR): the caller supplies `workId` in the accept body, so
        // it must be verified to belong to the SAME user before it is written
        // onto the Idea's `acceptedWorkId`. Without this a user could link
        // their own Idea to ANOTHER user's Work id (cross-owner reference;
        // downstream surfaces keyed on acceptedWorkId — detail links, budget/
        // usage rollups — would then point across the ownership boundary).
        // Return false (→ controller 404, existence-leak-safe) on mismatch.
        // The internal Goal-completion caller always passes the freshly-built
        // Work owned by this user, so the legitimate path is unaffected.
        const work = await this.works.findById(workId);
        if (!work || work.userId !== userId) return false;
        // The status transition stays governed by `fromStatuses` exactly as
        // before — a BUILDING Idea must not be yanked to ACCEPTED behind the
        // build that is still running.
        await this.repo.markAccepted(proposalId, userId, workId, fromStatuses);

        // ...but the provenance link is recorded REGARDLESS of that outcome.
        // Review §23.1 — `idea_works` is the authoritative 0..N record that
        // this Idea produced this Work; `status` answers a different
        // question (where the Idea is in its own lifecycle) and
        // `acceptedWorkId` is only the denormalized pointer at the most
        // recent link.
        //
        // This used to be gated on the transition succeeding, which lost the
        // link entirely whenever the Idea wasn't in `fromStatuses`. That is
        // not an edge case: `IdeaCard` routes queued / building / failed /
        // dismissed Ideas to `/works/new?proposal=…` too, so a Work built
        // from any of them vanished from the Idea and it kept reading "not
        // built" forever. Recording is idempotent (unique on
        // (ideaId, workId), `orIgnore`), so a retry is free.
        const linked = await this.recordProvenance(
            userId,
            proposalId,
            workId,
            opts.linkKind ?? 'linked',
            { workAlreadyLoadedFromIdeaId: work.acceptedFromIdeaId ?? null },
        );
        if (!linked) return false;

        // PR-3 — audit trail. Keyed on the link, not the status transition,
        // so the accepts that previously disappeared are now auditable.
        await this.recordIdeaActivity(userId, ActivityActionType.IDEA_ACCEPTED, 'accept', {
            proposalId,
            workId,
        });
        return true;
    }

    /**
     * Append the Idea↔Work provenance link and stamp the Work-side
     * back-pointer (`works.acceptedFromIdeaId`) when the Work has no
     * source Idea yet (a Work keeps at most ONE source Idea — review
     * §23.1).
     *
     * Returns whether the LINK was written. The two writes have
     * deliberately different failure contracts:
     *
     *   - `recordLink` is the authoritative one. A failure here means
     *     the Idea has no record of the Work, so the caller reports
     *     failure and the client's retry gets a real second chance
     *     (the insert is `orIgnore`, so retrying is free).
     *   - the back-pointer stamp is denormalized convenience. A
     *     failure there is logged and swallowed — the link already
     *     committed, and reporting failure would push callers into
     *     retrying a write that succeeded.
     */
    private async recordProvenance(
        userId: string,
        ideaId: string,
        workId: string,
        kind: IdeaWorkKind,
        opts: { workAlreadyLoadedFromIdeaId?: string | null } = {},
    ): Promise<boolean> {
        try {
            await this.ideaWorks.recordLink({ ideaId, workId, userId, kind });
        } catch (error) {
            this.logger.warn(
                `Failed to record Idea↔Work provenance (idea=${ideaId}, work=${workId}, kind=${kind}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
            return false;
        }

        try {
            let sourceIdeaId = opts.workAlreadyLoadedFromIdeaId;
            if (sourceIdeaId === undefined) {
                sourceIdeaId = (await this.works.findById(workId))?.acceptedFromIdeaId ?? null;
            }
            if (sourceIdeaId === null) {
                await this.works.update(workId, { acceptedFromIdeaId: ideaId });
            }
        } catch (error) {
            this.logger.warn(
                `Recorded the Idea↔Work link but failed to stamp works.acceptedFromIdeaId (idea=${ideaId}, work=${workId}): ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
        return true;
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
        await this.recordIdeaActivity(userId, ActivityActionType.IDEA_QUEUED, 'queue', {
            proposalId,
        });
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
        input: {
            description: string;
            title?: string;
            targetWorkId?: string | null;
            extraPrompt?: string | null;
        },
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
            // Re-run-existing-Work fields (Wave 0.3). Ownership of the
            // target Work is enforced at BUILD time (ensureCanEdit in the
            // executor) — a stale/foreign id degrades to a failed build.
            targetWorkId: input.targetWorkId ?? null,
            extraPrompt: input.extraPrompt ?? null,
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
     * also creating the new `WorkBuildRequest`. This service method
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
        await this.recordIdeaActivity(userId, ActivityActionType.IDEA_REBUILD_STARTED, 'rebuild', {
            proposalId,
        });
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
            // Review §23.1 — append the provenance link (history is
            // append-only; the previous link row survives a rebuild).
            await this.recordProvenance(
                input.userId,
                input.ideaId,
                input.outcome.workId,
                previousWorkId !== null ? 'rebuilt' : 'built',
            );
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
        await this.recordIdeaActivity(input.userId, ActivityActionType.IDEA_FAILED, 'fail', {
            ideaId: input.ideaId,
            kind,
        });
        return { outcome: 'failed', ideaId: input.ideaId, kind, message };
    }

    async getForUser(userId: string, proposalId: string) {
        return this.repo.findByIdForUser(proposalId, userId);
    }

    /**
     * All Works linked to this Idea (review §23.1 — 0..N), newest
     * first, with Work display fields for the "Linked Works" panel.
     * 404-shaped `null` when the Idea doesn't exist for this user.
     */
    async listLinkedWorks(userId: string, proposalId: string) {
        const proposal = await this.repo.findByIdForUser(proposalId, userId);
        if (!proposal) return null;
        return this.ideaWorks.listForIdeaWithWork(proposalId, userId);
    }

    /**
     * Per-Idea provenance summary for a batch of Ideas — how many Works
     * each one produced and the most recent of them. Feeds the
     * `linkedWorksCount` / `latestLinkedWorkId` response fields so the
     * Ideas list and cards can answer "is this built?" from the
     * authoritative `idea_works` table instead of the denormalized
     * `acceptedWorkId` (which is null for every Idea whose build never
     * transitioned its status — see `acceptInternal`).
     *
     * Owner-scoped and batched: one query for the whole page.
     */
    async summarizeLinks(
        userId: string,
        ideaIds: string[],
    ): Promise<Map<string, { count: number; latestWorkId: string }>> {
        return this.ideaWorks.summarizeForIdeas(ideaIds, userId);
    }

    async countPending(userId: string): Promise<number> {
        return this.repo.countPendingByUser(userId);
    }

    /**
     * Hard-delete an Idea (`DELETE /me/work-proposals/:id`), mirroring
     * the Mission delete contract (`MissionsService.delete`) but
     * GUARDED — unlike a Mission, an Idea has satellites that hold a
     * plain `ideaId` uuid with NO database FK (`agents.ideaId`,
     * `tasks.ideaId`), so an unconditional delete would silently strand
     * them pointing at a row that no longer exists.
     *
     * Refuses (409 + a machine-readable `reason`) when:
     *   - a build is in flight (QUEUED / BUILDING) — the Goal-completion
     *     handler would later try to accept an Idea that's gone;
     *   - Idea-scoped Agents still exist (`agents.scope = 'idea'`).
     *
     * Linked Works do NOT block the delete — see the note in the body.
     * Both remaining guards are recoverable by the user without leaving
     * the page: wait for the build, or re-scope the Agents.
     *
     * The web UI reads `reason` to tell the user exactly what blocks
     * the delete instead of showing a generic failure.
     */
    async delete(userId: string, proposalId: string): Promise<{ deleted: true }> {
        const proposal = await this.repo.findByIdForUser(proposalId, userId);
        if (!proposal) {
            throw new NotFoundException('Idea not found');
        }

        if (
            proposal.status === WorkProposalStatus.QUEUED ||
            proposal.status === WorkProposalStatus.BUILDING
        ) {
            throw new ConflictException({
                reason: 'build-in-flight' satisfies IdeaDeleteBlockedReason,
                count: 0,
                message: 'This Idea is being built. Wait for the build to finish, then delete it.',
            });
        }

        // Linked Works no longer block the delete.
        //
        // The guard that used to live here refused any Idea with
        // `idea_works` rows and told the user to "unlink or delete them
        // first" — but there is no unlink endpoint, so the only way out
        // was deleting the Work itself. That made every Idea that had
        // ever produced a Work permanently undeletable, which is the
        // opposite of what the guard was protecting.
        //
        // Dropping it is safe because both foreign keys already say what
        // should happen:
        //   - `idea_works.ideaId` is ON DELETE CASCADE, so the provenance
        //     rows go with the Idea;
        //   - `works.acceptedFromIdeaId` is ON DELETE SET NULL, so the
        //     built Work SURVIVES and merely loses its back-pointer.
        //
        // What is genuinely lost is the record of which Idea a Work came
        // from. That is a real cost, but it is the user's call to make —
        // and the confirm dialog now names the Works that will be
        // unlinked before they make it.

        const ideaAgents = await this.countIdeaAgents(userId, proposalId);
        if (ideaAgents > 0) {
            throw new ConflictException({
                reason: 'idea-agents' satisfies IdeaDeleteBlockedReason,
                count: ideaAgents,
                message: `This Idea has ${ideaAgents} Agent(s) scoped to it. Delete or re-scope them first.`,
            });
        }

        const ok = await this.repo.deleteForUser(proposalId, userId);
        if (!ok) {
            // Lost a race with a concurrent delete — same shape as a
            // never-existed id, which is what the caller now sees.
            throw new NotFoundException('Idea not found');
        }

        await this.recordIdeaActivity(userId, ActivityActionType.IDEA_DELETED, 'delete', {
            proposalId,
            title: proposal.title,
        });
        return { deleted: true };
    }

    /**
     * Count non-archived Agents scoped to this Idea. Returns 0 when the
     * Agent repository isn't wired (hand-rolled test constructors) —
     * the delete then proceeds on its other guards, exactly as it did
     * before Agents existed.
     */
    private async countIdeaAgents(userId: string, proposalId: string): Promise<number> {
        if (!this.agentsRepo) return 0;
        return this.agentsRepo.count({
            where: { userId, ideaId: proposalId, status: Not(AgentStatus.ARCHIVED) },
        });
    }
}
