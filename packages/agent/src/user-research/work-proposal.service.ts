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
