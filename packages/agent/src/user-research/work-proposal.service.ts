import { Injectable, Logger } from '@nestjs/common';
import { AiFacadeService } from '../facades/ai.facade';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { WorkProposalRepository } from './work-proposal.repository';
import { permissiveWorkProposalsBatchSchema, type WorkProposalDraft } from './schemas';
import { coerceWorkProposal } from './proposal-coercion';
import { PROPOSALS_SYSTEM_PROMPT, buildProposalsPrompt } from './prompts';
import { resolveAiProviderForResearch } from './provider-resolver';
import {
    WorkProposalStatus,
    type WorkProposal,
    type WorkProposalSource,
} from '../entities/work-proposal.entity';

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

        try {
            // Use the permissive schema so low-quality model output (sloppy
            // slugs, wrong enum values, off-by-one length bounds) doesn't
            // make JSON generation reject the whole batch. coerceWorkProposal
            // below clips/slugifies/filters each draft into the strict shape.
            const result = await this.aiFacade.askJson(
                [
                    PROPOSALS_SYSTEM_PROMPT,
                    buildProposalsPrompt(profile, existingWorkNames, availablePluginIds),
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
        }));

        const existingProposals = await this.repo.findRecentByUser(userId).catch(() => []);
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

    async list(userId: string, statuses: WorkProposalStatus[] = [WorkProposalStatus.PENDING]) {
        return this.repo.findByUser(userId, statuses);
    }

    async dismiss(userId: string, proposalId: string): Promise<boolean> {
        return this.repo.markDismissed(proposalId, userId);
    }

    async markAccepted(userId: string, proposalId: string, workId: string): Promise<boolean> {
        return this.repo.markAccepted(proposalId, userId, workId);
    }

    async getForUser(userId: string, proposalId: string) {
        return this.repo.findByIdForUser(proposalId, userId);
    }

    async countPending(userId: string): Promise<number> {
        return this.repo.countPendingByUser(userId);
    }
}
