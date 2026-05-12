import { Injectable, Logger } from '@nestjs/common';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateObject } from 'ai';
import { AiFacadeService } from '../facades/ai.facade';
import { UserRepository } from '../database/repositories/user.repository';
import { WorkRepository } from '../database/repositories/work.repository';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { WorkProposalRepository } from './work-proposal.repository';
import { workProposalsBatchSchema, type WorkProposalsBatch } from './schemas';
import { PROPOSALS_SYSTEM_PROMPT, buildProposalsPrompt } from './prompts';
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
        let tokensUsed = 0;
        let parsed: WorkProposalsBatch;

        try {
            const providerConfig = await this.aiFacade.getProviderConfig({
                userId,
                workId: userId,
            });
            if (!providerConfig.baseUrl || !providerConfig.apiKey) {
                return {
                    status: 'error',
                    proposals: [],
                    tokensUsed: 0,
                    error: 'ai-provider-not-configured',
                };
            }
            const provider = createOpenAICompatible({
                name: providerConfig.providerId,
                baseURL: providerConfig.baseUrl,
                apiKey: providerConfig.apiKey,
            });
            modelName =
                providerConfig.routing.complexModel ??
                providerConfig.routing.mediumModel ??
                providerConfig.defaultModel ??
                '';
            if (!modelName) {
                return {
                    status: 'error',
                    proposals: [],
                    tokensUsed: 0,
                    error: 'no-model-configured',
                };
            }
            providerName = providerConfig.providerName ?? providerConfig.providerId;

            const result = await generateObject({
                model: provider(modelName),
                schema: workProposalsBatchSchema,
                system: PROPOSALS_SYSTEM_PROMPT,
                prompt: buildProposalsPrompt(profile, existingWorkNames, availablePluginIds),
                temperature: 0.4,
                maxRetries: 2,
            });

            parsed = workProposalsBatchSchema.parse(result.object);
            tokensUsed = result.usage?.totalTokens ?? 0;
        } catch (err) {
            const message = (err as Error).message;
            this.logger.warn(`Proposal generation failed for ${userId}: ${message}`);
            return { status: 'error', proposals: [], tokensUsed, error: message };
        }

        // Drop plugin IDs the registry doesn't recognize.
        const pluginSet = new Set(availablePluginIds);
        const inputs = parsed.proposals.map((p) => ({
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
            reasoning: p.reasoning,
            source: opts.source,
            generationRunId: opts.generationRunId,
        }));

        const saved = await this.repo.bulkInsert(inputs);

        this.logger.log(
            `Generated ${saved.length} proposal(s) for ${userId} via "${providerName}" (${modelName}), tokens=${tokensUsed}`,
        );

        return { status: 'generated', proposals: saved, tokensUsed };
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
