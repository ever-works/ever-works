import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { generateText, stepCountIs } from 'ai';
import { AiFacadeService } from '../facades/ai.facade';
import { SearchFacadeService } from '../facades/search.facade';
import { ContentExtractorFacadeService } from '../facades/content-extractor.facade';
import { UserRepository } from '../database/repositories/user.repository';
import { AuthAccountRepository } from '../database/repositories/auth-account.repository';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import type { InferredUserProfile } from '../entities';
import { UserResearchCompletedEvent, UserResearchFailedEvent } from './events';
import { USER_RESEARCH_AGENT_PROMPT, buildSeedPrompt, deriveVerticals } from './prompts';
import { inferredProfileSchema, type InferredProfile } from './schemas';
import { UserResearchLimitsService, UserResearchRateLimitedError } from './limits';
import { resolveAiProviderForResearch, resolveSearchProviderIds } from './provider-resolver';
import { createSearchWebTool, createFetchPageTool, createFinalizeTool } from './tools';

export interface UserResearchResult {
    status: 'completed' | 'rate-limited' | 'no-data' | 'error';
    profile?: InferredUserProfile;
    tokensUsed: number;
    toolCallsCount: number;
    durationMs: number;
    error?: string;
}

export interface UserResearchOptions {
    /** Hard wall-clock cap (ms). Default 120_000 (2 min). */
    timeoutMs?: number;
    /** Max tool-calling steps. Default 10. */
    maxSteps?: number;
    /** Optional abort signal from caller (e.g. Trigger.dev). */
    abortSignal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_STEPS = 10;

/**
 * Tool-calling agent that researches a newly signed-up user via web search +
 * content extraction and persists the inferred profile on the User row.
 * Bounded by step count, wall-clock timeout, and per-user daily caps.
 */
@Injectable()
export class UserResearchService {
    private readonly logger = new Logger(UserResearchService.name);

    constructor(
        private readonly users: UserRepository,
        private readonly authAccounts: AuthAccountRepository,
        private readonly aiFacade: AiFacadeService,
        private readonly searchFacade: SearchFacadeService,
        private readonly contentExtractor: ContentExtractorFacadeService,
        private readonly registry: PluginRegistryService,
        private readonly limits: UserResearchLimitsService,
        @Optional() private readonly events?: EventEmitter2,
    ) {}

    async research(userId: string, opts: UserResearchOptions = {}): Promise<UserResearchResult> {
        const startedAt = Date.now();
        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;

        const user = await this.users.findById(userId);
        if (!user) {
            return {
                status: 'error',
                tokensUsed: 0,
                toolCallsCount: 0,
                durationMs: 0,
                error: 'user-not-found',
            };
        }

        if (user.userResearchOptOut) {
            this.logger.log(`User ${userId} has opted out of research; skipping`);
            return { status: 'no-data', tokensUsed: 0, toolCallsCount: 0, durationMs: 0 };
        }

        try {
            await this.limits.assertCanRun(userId);
        } catch (err) {
            if (err instanceof UserResearchRateLimitedError) {
                this.logger.warn(`Research rate-limited for user ${userId}: ${err.message}`);
                return {
                    status: 'rate-limited',
                    tokensUsed: 0,
                    toolCallsCount: 0,
                    durationMs: 0,
                    error: err.message,
                };
            }
            throw err;
        }

        await this.limits.incrementRuns(userId);

        let socials: string[] = [];
        try {
            const accounts = await this.authAccounts.findProviderAccountsByUserId(userId);
            socials = accounts
                .map((a) => a.providerId)
                .filter((p): p is string => typeof p === 'string' && p !== 'local');
        } catch (err) {
            this.logger.debug(
                `Could not load social accounts for user ${userId}: ${(err as Error).message}`,
            );
        }

        let resolvedModel;
        let providerName: string;
        let searchChain: string[];
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
                    tokensUsed: 0,
                    toolCallsCount: 0,
                    durationMs: Date.now() - startedAt,
                    error: 'ai-provider-not-configured',
                };
            }
            resolvedModel = resolved.model;
            providerName = resolved.providerName;
            searchChain = await resolveSearchProviderIds(this.registry, userId);
        } catch (err) {
            const message = (err as Error).message;
            this.logger.warn(`Provider resolution failed for ${userId}: ${message}`);
            return {
                status: 'error',
                tokensUsed: 0,
                toolCallsCount: 0,
                durationMs: Date.now() - startedAt,
                error: message,
            };
        }

        let finalProfile: InferredProfile | null = null;
        let tokensUsed = 0;
        let toolCallsCount = 0;

        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signals = opts.abortSignal
            ? AbortSignal.any([timeoutSignal, opts.abortSignal])
            : timeoutSignal;

        const seedPrompt = buildSeedPrompt(user, socials);

        try {
            this.logger.log(
                `User research starting for ${userId} via "${providerName}" (timeout=${timeoutMs}ms, steps=${maxSteps})`,
            );

            const result = await generateText({
                model: resolvedModel,
                system: USER_RESEARCH_AGENT_PROMPT,
                prompt: seedPrompt,
                tools: {
                    searchWeb: createSearchWebTool({
                        searchFacade: this.searchFacade,
                        limits: this.limits,
                        userId,
                        providerChain: searchChain,
                        logger: this.logger,
                    }),
                    fetchPage: createFetchPageTool({
                        contentExtractor: this.contentExtractor,
                        limits: this.limits,
                        userId,
                        logger: this.logger,
                    }),
                    finalize: createFinalizeTool({
                        onFinalize: (profile) => {
                            finalProfile = profile;
                        },
                    }),
                },
                stopWhen: stepCountIs(maxSteps),
                abortSignal: signals,
                maxRetries: 1,
                // Increment tokens per step so aborted/timed-out runs still
                // count against the daily cap (tokens were already spent).
                onStepFinish: (step) => {
                    const t = step.usage?.totalTokens ?? 0;
                    if (t > 0) {
                        tokensUsed += t;
                        this.limits.addTokens(userId, t).catch(() => undefined);
                    }
                    toolCallsCount += step.toolCalls?.length ?? 0;
                },
            });

            // Reconcile with the SDK's final totals so we don't undercount if
            // onStepFinish didn't see every step's usage. The delta is committed
            // to the daily cap; per-step calls already covered the rest.
            const sdkToolCalls = result.steps.reduce(
                (sum, step) => sum + (step.toolCalls?.length ?? 0),
                0,
            );
            toolCallsCount = Math.max(toolCallsCount, sdkToolCalls);
            const sdkTotal = result.totalUsage?.totalTokens ?? 0;
            if (sdkTotal > tokensUsed) {
                await this.limits.addTokens(userId, sdkTotal - tokensUsed);
                tokensUsed = sdkTotal;
            }
        } catch (err) {
            const message = (err as Error).message;
            this.logger.warn(`User research agent failed for ${userId}: ${message}`);
            this.events?.emit(
                UserResearchFailedEvent.EVENT_NAME,
                new UserResearchFailedEvent(userId, message),
            );
            return {
                status: 'error',
                tokensUsed,
                toolCallsCount,
                durationMs: Date.now() - startedAt,
                error: message,
            };
        }

        if (!finalProfile) {
            this.logger.log(
                `User research for ${userId} ended without finalize; no profile persisted`,
            );
            return {
                status: 'no-data',
                tokensUsed,
                toolCallsCount,
                durationMs: Date.now() - startedAt,
            };
        }

        // Re-parse to lock the type — AI SDK's tool execute() hands back a partial.
        const validated = inferredProfileSchema.parse(finalProfile);
        const inferredInterests: InferredUserProfile = {
            industry: validated.industry,
            role: validated.role,
            expertise: (validated.expertise ?? []) as string[],
            topics: (validated.topics ?? []) as string[],
            businessType: validated.businessType,
            confidence: validated.confidence ?? 'low',
            sources: (validated.sources ?? []) as Array<{ url: string; title: string }>,
            researchedAt: new Date().toISOString(),
            tokensUsed,
            toolCallsCount,
        };
        const verticals = deriveVerticals(inferredInterests);

        await this.users.update(userId, {
            inferredInterests,
            suggestedVerticals: verticals,
        });

        const durationMs = Date.now() - startedAt;
        this.logger.log(
            `User research completed for ${userId}: confidence=${inferredInterests.confidence}, ` +
                `verticals=[${verticals.join(',')}], steps=${toolCallsCount}, tokens=${tokensUsed}, durationMs=${durationMs}`,
        );

        this.events?.emit(
            UserResearchCompletedEvent.EVENT_NAME,
            new UserResearchCompletedEvent(user, validated, tokensUsed, toolCallsCount),
        );

        return {
            status: 'completed',
            profile: inferredInterests,
            tokensUsed,
            toolCallsCount,
            durationMs,
        };
    }
}
