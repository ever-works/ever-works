import {
    BadRequestException,
    ConflictException,
    GoneException,
    Inject,
    Injectable,
    Logger,
    NotFoundException,
    type OnApplicationBootstrap,
    Optional,
} from '@nestjs/common';
import {
    MEMORY_FACT_ACTIVE_MAX,
    MEMORY_FACT_BODY_MAX,
    MEMORY_FACT_FORGET_RETENTION_DAYS,
    MEMORY_FACT_LIST_LIMIT_MAX,
    MEMORY_FACT_PINNED_MAX,
    MEMORY_FACT_PROPOSED_MAX,
    type MemoryFactDto,
    type MemoryFactForgetAllResultDto,
    type MemoryFactForgetResultDto,
    type MemoryFactListDto,
    type MemoryFactOrigin,
    type MemoryFactScope,
    type MemoryFactStatsDto,
    type MemoryFactStatus,
} from '@ever-works/contracts';
import { MemoryFactRepository } from '../database/repositories/memory-fact.repository';
import { AgentRepository } from '../database/repositories/agent.repository';
import type { OwnershipScope } from '../database/ownership-scope';
import type { MemoryFact } from '../entities/memory-fact.entity';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import {
    MEMORY_FACT_EMBED_DISPATCHER,
    type MemoryFactEmbedDispatcher,
} from '../tasks/memory-fact-embed-dispatcher';
import {
    JOB_RUNTIME_PROVIDER_REGISTRY,
    type JobRuntimeProviderRegistry,
} from '../tasks/job-runtime.providers';
import { MemoryFactSearchService } from './memory-fact-search.service';
import { MemoryFactVectorIndexService } from './memory-fact-vector-index.service';

/** Who is acting, and in which workspace. */
export interface MemoryFactActor {
    userId: string;
    /** The request's ownership scope. HTTP callers always pass one. */
    ownership?: OwnershipScope;
}

/** Input to {@link MemoryFactService.create}. */
export interface CreateMemoryFactCommand {
    body: string;
    scope?: MemoryFactScope;
    agentId?: string | null;
    pinned?: boolean;
    /** Defaults to `user`. Anything else lands `proposed`. */
    origin?: MemoryFactOrigin;
    sourceRunId?: string | null;
    sourceConversationId?: string | null;
    sourceAgentId?: string | null;
}

/** Input to {@link MemoryFactService.update}. Every field optional. */
export interface UpdateMemoryFactCommand {
    body?: string;
    scope?: MemoryFactScope;
    agentId?: string | null;
    pinned?: boolean;
}

/** Input to {@link MemoryFactService.list}. */
export interface ListMemoryFactsQuery {
    q?: string;
    status?: MemoryFactStatus;
    pinnedOnly?: boolean;
    scope?: MemoryFactScope;
    agentId?: string;
    limit?: number;
    cursor?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * AW-07 — Memory facts, the atomic tier of Memory.
 *
 * Owns every invariant of a fact:
 *
 *  - the body is trimmed and 1–{@link MEMORY_FACT_BODY_MAX} characters;
 *  - at most {@link MEMORY_FACT_ACTIVE_MAX} active facts, at most
 *    {@link MEMORY_FACT_PROPOSED_MAX} proposals and at most
 *    {@link MEMORY_FACT_PINNED_MAX} pins per workspace;
 *  - a human's own write lands `active`; every other origin lands
 *    `proposed` and is never recalled until a human accepts it;
 *  - `scope` and `agentId` agree, and a named agent belongs to the caller's
 *    workspace;
 *  - no two live facts in a workspace share a body (case-insensitively);
 *  - forgetting is soft and restorable for
 *    {@link MEMORY_FACT_FORGET_RETENTION_DAYS} days;
 *  - every mutation writes exactly one activity row whose details carry ids
 *    and counts, never the body.
 *
 * The caps, the duplicate defence and the status transitions are checks
 * followed by a write, so each single-fact mutation reads, checks and writes
 * inside `MemoryFactRepository.withWorkspaceWriteLock`: two simultaneous
 * requests in one workspace cannot both see the last free slot, or both see
 * no duplicate.
 *
 * Embedding is asynchronous and optional: after a write the fact is handed to
 * the job runtime through {@link MEMORY_FACT_EMBED_DISPATCHER}. A `null`
 * dispatch, a missing dispatcher or a failing one never fails the write —
 * the fact is saved, literal search finds it, and the nightly sweep embeds it.
 *
 * The dispatcher resolves through the job-runtime provider registry, so
 * whichever runtime is active runs the embed. When none can (nothing
 * registered, or the registered runtime is not enabled) that is said ONCE,
 * at startup — never as a warning per saved fact.
 */
@Injectable()
export class MemoryFactService implements OnApplicationBootstrap {
    private readonly logger = new Logger(MemoryFactService.name);

    constructor(
        private readonly facts: MemoryFactRepository,
        private readonly search: MemoryFactSearchService,
        @Optional() private readonly agents?: AgentRepository,
        @Optional() private readonly vectors?: MemoryFactVectorIndexService,
        @Optional() private readonly activityLog?: ActivityLogService,
        @Optional()
        @Inject(MEMORY_FACT_EMBED_DISPATCHER)
        private readonly embedDispatcher?: MemoryFactEmbedDispatcher | null,
        @Optional()
        @Inject(JOB_RUNTIME_PROVIDER_REGISTRY)
        private readonly jobRuntimeRegistry?: JobRuntimeProviderRegistry | null,
    ) {}

    /**
     * One startup line when facts will be saved without being embedded, so
     * the no-runtime install is observable without a warning per write.
     */
    onApplicationBootstrap(): void {
        const gap = this.embedRuntimeGap();
        if (gap) {
            this.logger.log(
                `Memory facts: ${gap} — facts are saved and matched by exact words; ` +
                    'the nightly sweep embeds them once an AI provider and a vector store are available.',
            );
        }
    }

    /** Why `memory-fact-embed` cannot be enqueued right now, or `null` when it can. */
    embedRuntimeGap(): string | null {
        if (!this.embedDispatcher) {
            return 'no job runtime is configured to run memory-fact-embed';
        }
        if (!this.jobRuntimeRegistry) {
            // A dispatcher bound outside the registry (tests, custom wiring):
            // nothing further to inspect.
            return null;
        }
        const active = this.jobRuntimeRegistry.getActive();
        if (!active) {
            return 'no job runtime is registered to run memory-fact-embed';
        }
        let enabled = true;
        try {
            enabled = active.isEnabled();
        } catch {
            enabled = false;
        }
        return enabled ? null : `the '${active.runtimeId}' job runtime is not enabled`;
    }

    // ─── Reads ──────────────────────────────────────────────────────────────

    async list(actor: MemoryFactActor, query: ListMemoryFactsQuery): Promise<MemoryFactListDto> {
        const limit = clampLimit(query.limit);
        const counts = await this.facts.countByStatus(actor.userId, actor.ownership);
        const filter = {
            status: query.status ?? 'active',
            pinnedOnly: query.pinnedOnly === true,
            scope: query.scope,
            agentId: query.agentId,
        };

        const q = query.q?.trim();
        if (q) {
            const result = await this.search.search(actor, q, filter);
            return {
                facts: result.results.map((hit) =>
                    toMemoryFactDto(hit.fact, { score: hit.score, literalMatch: hit.literalMatch }),
                ),
                total: result.results.length,
                counts,
                semantic: result.semantic,
            };
        }

        const offset = decodeCursor(query.cursor);
        const { rows, total } = await this.facts.listForOwner(actor.userId, actor.ownership, {
            ...filter,
            limit,
            offset,
        });
        const nextOffset = offset + rows.length;
        const dto: MemoryFactListDto = {
            facts: rows.map((row) => toMemoryFactDto(row)),
            total,
            counts,
            semantic: await this.semanticAvailable(actor),
        };
        if (nextOffset < total && rows.length > 0) {
            dto.nextCursor = encodeCursor(nextOffset);
        }
        return dto;
    }

    async stats(actor: MemoryFactActor): Promise<MemoryFactStatsDto> {
        const counts = await this.facts.countByStatus(actor.userId, actor.ownership);
        return {
            ...counts,
            capacity: MEMORY_FACT_ACTIVE_MAX,
            pinnedCapacity: MEMORY_FACT_PINNED_MAX,
            proposedCapacity: MEMORY_FACT_PROPOSED_MAX,
            semantic: await this.semanticAvailable(actor),
        };
    }

    async get(actor: MemoryFactActor, id: string): Promise<MemoryFactDto> {
        return toMemoryFactDto(await this.requireOwned(actor, id));
    }

    // ─── Writes ─────────────────────────────────────────────────────────────

    async create(actor: MemoryFactActor, command: CreateMemoryFactCommand): Promise<MemoryFactDto> {
        const body = validateBody(command.body);
        const origin: MemoryFactOrigin = command.origin ?? 'user';
        const status: MemoryFactStatus = origin === 'user' ? 'active' : 'proposed';
        const { scope, agentId } = await this.resolveScope(actor, command.scope, command.agentId);
        const pinned = command.pinned === true;

        // The caps and the duplicate check are only true while nothing else
        // writes into this workspace — so they run, with the insert, under the
        // workspace write lock. The activity row and the embed hand-off happen
        // after it is released, once the row is committed and visible.
        const fact = await this.facts.withWorkspaceWriteLock(
            actor.userId,
            actor.ownership,
            async (facts) => {
                const counts = await facts.countByStatus(actor.userId, actor.ownership);
                if (status === 'active' && counts.active >= MEMORY_FACT_ACTIVE_MAX) {
                    throw memoryFullError();
                }
                if (status === 'proposed' && counts.proposed >= MEMORY_FACT_PROPOSED_MAX) {
                    throw new ConflictException({
                        code: 'memory_fact_proposals_full',
                        message: `Memory proposal dropped — ${MEMORY_FACT_PROPOSED_MAX} proposals are already waiting for review.`,
                    });
                }
                if (pinned) {
                    if (status !== 'active') {
                        throw new ConflictException({
                            code: 'memory_fact_pin_requires_active',
                            message: 'Only an active fact can be pinned.',
                        });
                    }
                    if (counts.pinned >= MEMORY_FACT_PINNED_MAX) {
                        throw pinsFullError();
                    }
                }
                await assertNoDuplicate(facts, actor, body);

                return facts.create({
                    userId: actor.userId,
                    ownership: actor.ownership,
                    body,
                    status,
                    origin,
                    scope,
                    agentId,
                    pinned,
                    sourceRunId: command.sourceRunId ?? null,
                    sourceConversationId: command.sourceConversationId ?? null,
                    sourceAgentId: command.sourceAgentId ?? null,
                });
            },
        );

        await this.record(actor, ActivityActionType.MEMORY_FACT_CREATED, 'Remembered a fact', {
            factId: fact.id,
            origin,
            status,
            scope,
            agentId,
            pinned,
        });
        await this.enqueueEmbed(fact);
        return toMemoryFactDto(fact);
    }

    async update(
        actor: MemoryFactActor,
        id: string,
        command: UpdateMemoryFactCommand,
    ): Promise<MemoryFactDto> {
        // Read, check and write under the workspace write lock: a pin cap or a
        // duplicate body checked outside it could be walked past by a second
        // edit landing between the check and the write.
        const outcome = await this.facts.withWorkspaceWriteLock(
            actor.userId,
            actor.ownership,
            async (facts) => {
                const current = await requireOwnedIn(facts, actor, id);
                if (current.status === 'forgotten') {
                    throw new ConflictException({
                        code: 'memory_fact_forgotten',
                        message: 'This fact is forgotten. Restore it before editing it.',
                    });
                }

                const patch: Parameters<MemoryFactRepository['updateOwned']>[3] = {};
                const changed: string[] = [];

                if (command.body !== undefined) {
                    const body = validateBody(command.body);
                    if (body !== current.body) {
                        await assertNoDuplicate(facts, actor, body, current.id);
                        patch.body = body;
                        // A new body invalidates the stored vector's coordinates: the
                        // fact is re-embedded, and until then it is matched by words.
                        patch.vectorStoreId = null;
                        patch.embeddingModel = null;
                        patch.embeddingDims = null;
                        patch.embeddedAt = null;
                        changed.push('body');
                    }
                }

                if (command.scope !== undefined || command.agentId !== undefined) {
                    const nextScope = command.scope ?? current.scope;
                    const nextAgentInput =
                        command.agentId !== undefined
                            ? command.agentId
                            : nextScope === 'agent'
                              ? (current.agentId ?? null)
                              : null;
                    const { scope, agentId } = await this.resolveScope(
                        actor,
                        nextScope,
                        nextAgentInput,
                    );
                    if (scope !== current.scope || agentId !== (current.agentId ?? null)) {
                        patch.scope = scope;
                        patch.agentId = agentId;
                        changed.push('scope');
                    }
                }

                if (command.pinned !== undefined && command.pinned !== current.pinned) {
                    if (command.pinned) {
                        if (current.status !== 'active') {
                            throw new ConflictException({
                                code: 'memory_fact_pin_requires_active',
                                message: 'Only an active fact can be pinned.',
                            });
                        }
                        const counts = await facts.countByStatus(actor.userId, actor.ownership);
                        if (counts.pinned >= MEMORY_FACT_PINNED_MAX) {
                            throw pinsFullError();
                        }
                    }
                    patch.pinned = command.pinned;
                    changed.push('pinned');
                }

                if (changed.length === 0) {
                    return { fact: current, changed };
                }

                const updated = await facts.updateOwned(id, actor.userId, actor.ownership, patch);
                if (!updated) {
                    throw notFound(id);
                }
                return { fact: updated, changed };
            },
        );

        if (outcome.changed.length === 0) {
            return toMemoryFactDto(outcome.fact);
        }
        await this.record(actor, ActivityActionType.MEMORY_FACT_UPDATED, 'Edited a fact', {
            factId: id,
            changed: outcome.changed,
        });
        if (outcome.changed.includes('body')) {
            await this.enqueueEmbed(outcome.fact);
        }
        return toMemoryFactDto(outcome.fact);
    }

    async forget(actor: MemoryFactActor, id: string): Promise<MemoryFactForgetResultDto> {
        const outcome = await this.facts.withWorkspaceWriteLock(
            actor.userId,
            actor.ownership,
            async (facts) => {
                const current = await requireOwnedIn(facts, actor, id);
                if (current.status === 'forgotten' && current.forgottenAt) {
                    // Idempotent: a double click must not reset the retention clock.
                    return {
                        forgottenAt: current.forgottenAt,
                        previousStatus: null as MemoryFactStatus | null,
                    };
                }
                const now = new Date();
                const updated = await facts.updateOwned(id, actor.userId, actor.ownership, {
                    status: 'forgotten',
                    forgottenAt: now,
                    pinned: false,
                });
                if (!updated) {
                    throw notFound(id);
                }
                return { forgottenAt: now, previousStatus: current.status };
            },
        );

        if (outcome.previousStatus !== null) {
            await this.record(actor, ActivityActionType.MEMORY_FACT_FORGOTTEN, 'Forgot a fact', {
                factId: id,
                previousStatus: outcome.previousStatus,
            });
        }
        return {
            id,
            status: 'forgotten',
            restorableUntil: restorableUntil(outcome.forgottenAt).toISOString(),
        };
    }

    async restore(actor: MemoryFactActor, id: string): Promise<MemoryFactDto> {
        const updated = await this.facts.withWorkspaceWriteLock(
            actor.userId,
            actor.ownership,
            async (facts) => {
                const current = await requireOwnedIn(facts, actor, id);
                if (current.status !== 'forgotten') {
                    throw new ConflictException({
                        code: 'memory_fact_not_forgotten',
                        message: 'Only a forgotten fact can be restored.',
                    });
                }
                if (
                    current.forgottenAt &&
                    restorableUntil(current.forgottenAt).getTime() < Date.now()
                ) {
                    throw new GoneException({
                        code: 'memory_fact_restore_expired',
                        message: `This fact was forgotten more than ${MEMORY_FACT_FORGET_RETENTION_DAYS} days ago and can no longer be restored.`,
                    });
                }
                const counts = await facts.countByStatus(actor.userId, actor.ownership);
                if (counts.active >= MEMORY_FACT_ACTIVE_MAX) {
                    throw memoryFullError();
                }
                await assertNoDuplicate(facts, actor, current.body, current.id);

                const restored = await facts.updateOwned(id, actor.userId, actor.ownership, {
                    status: 'active',
                    forgottenAt: null,
                });
                if (!restored) {
                    throw notFound(id);
                }
                return restored;
            },
        );

        await this.record(actor, ActivityActionType.MEMORY_FACT_RESTORED, 'Restored a fact', {
            factId: id,
        });
        await this.enqueueEmbed(updated);
        return toMemoryFactDto(updated);
    }

    async accept(actor: MemoryFactActor, id: string): Promise<MemoryFactDto> {
        const { current, updated } = await this.facts.withWorkspaceWriteLock(
            actor.userId,
            actor.ownership,
            async (facts) => {
                const proposal = await requireOwnedIn(facts, actor, id);
                if (proposal.status !== 'proposed') {
                    throw new ConflictException({
                        code: 'memory_fact_not_proposed',
                        message: 'Only a proposed fact can be accepted.',
                    });
                }
                const counts = await facts.countByStatus(actor.userId, actor.ownership);
                if (counts.active >= MEMORY_FACT_ACTIVE_MAX) {
                    throw memoryFullError();
                }
                const accepted = await facts.updateOwned(id, actor.userId, actor.ownership, {
                    status: 'active',
                });
                if (!accepted) {
                    throw notFound(id);
                }
                return { current: proposal, updated: accepted };
            },
        );

        await this.record(
            actor,
            ActivityActionType.MEMORY_FACT_ACCEPTED,
            'Accepted a proposed fact',
            {
                factId: id,
                sourceAgentId: current.sourceAgentId ?? null,
                sourceRunId: current.sourceRunId ?? null,
            },
        );
        await this.enqueueEmbed(updated);
        return toMemoryFactDto(updated);
    }

    async discard(actor: MemoryFactActor, id: string): Promise<void> {
        const current = await this.facts.withWorkspaceWriteLock(
            actor.userId,
            actor.ownership,
            async (facts) => {
                const proposal = await requireOwnedIn(facts, actor, id);
                if (proposal.status !== 'proposed') {
                    throw new ConflictException({
                        code: 'memory_fact_not_proposed',
                        message: 'Only a proposed fact can be discarded.',
                    });
                }
                const discarded = await facts.updateOwned(id, actor.userId, actor.ownership, {
                    status: 'forgotten',
                    forgottenAt: new Date(),
                    pinned: false,
                });
                if (!discarded) {
                    throw notFound(id);
                }
                return proposal;
            },
        );

        await this.record(
            actor,
            ActivityActionType.MEMORY_FACT_DISCARDED,
            'Discarded a proposed fact',
            { factId: id, sourceAgentId: current.sourceAgentId ?? null },
        );
    }

    /**
     * Forget every active and proposed fact in the workspace. The caller —
     * the controller — has already checked the typed confirmation. Writes
     * `memory_facts` only.
     */
    async forgetAll(actor: MemoryFactActor): Promise<MemoryFactForgetAllResultDto> {
        const forgotten = await this.facts.forgetAll(actor.userId, actor.ownership, new Date());
        await this.record(actor, ActivityActionType.MEMORY_FACTS_CLEARED, 'Forgot every fact', {
            forgotten,
        });
        return { forgotten };
    }

    // ─── internals ──────────────────────────────────────────────────────────

    private async requireOwned(actor: MemoryFactActor, id: string): Promise<MemoryFact> {
        return requireOwnedIn(this.facts, actor, id);
    }

    private async resolveScope(
        actor: MemoryFactActor,
        scope: MemoryFactScope | undefined,
        agentId: string | null | undefined,
    ): Promise<{ scope: MemoryFactScope; agentId: string | null }> {
        const resolved: MemoryFactScope = scope ?? (agentId ? 'agent' : 'workspace');
        if (resolved === 'workspace') {
            if (agentId) {
                throw new BadRequestException({
                    code: 'memory_fact_scope_mismatch',
                    message: 'A workspace fact cannot be limited to an agent.',
                });
            }
            return { scope: 'workspace', agentId: null };
        }
        if (!agentId) {
            throw new BadRequestException({
                code: 'memory_fact_agent_required',
                message: 'Choose the agent this fact is limited to.',
            });
        }
        if (this.agents) {
            const agent = await this.agents.findByIdAndUser(agentId, actor.userId, actor.ownership);
            if (!agent) {
                // 404, not 403 — an agent in another workspace does not exist here.
                throw new NotFoundException(`Agent ${agentId} not found`);
            }
        }
        return { scope: 'agent', agentId };
    }

    private async semanticAvailable(actor: MemoryFactActor): Promise<boolean> {
        if (!this.vectors) return false;
        try {
            return await this.vectors.isAvailable({
                userId: actor.userId,
                organizationId: actor.ownership?.organizationId ?? null,
                tenantId: actor.ownership?.tenantId ?? null,
            });
        } catch {
            return false;
        }
    }

    private async enqueueEmbed(fact: MemoryFact): Promise<void> {
        if (!this.embedDispatcher) {
            return;
        }
        try {
            const runId = await this.embedDispatcher.dispatchMemoryFactEmbed({
                factId: fact.id,
                userId: fact.userId,
            });
            if (runId === null) {
                this.logger.debug(
                    `memory-fact ${fact.id}: embed not enqueued; the sweep will embed it`,
                );
            }
        } catch (error) {
            // Deferred work, never a failed write.
            this.logger.warn(
                `memory-fact ${fact.id}: embed dispatch failed (${
                    error instanceof Error ? error.message : String(error)
                }); the sweep will embed it`,
            );
        }
    }

    private async record(
        actor: MemoryFactActor,
        actionType: ActivityActionType,
        summary: string,
        details: Record<string, unknown>,
    ): Promise<void> {
        if (!this.activityLog) return;
        try {
            await this.activityLog.log({
                userId: actor.userId,
                actionType,
                action: actionType,
                status: ActivityStatus.COMPLETED,
                summary,
                details,
            });
        } catch (error) {
            // The fact is already written; losing its activity row must not
            // turn a successful edit into an error the user retries.
            this.logger.warn(
                `activity row for ${actionType} failed: ${
                    error instanceof Error ? error.message : String(error)
                }`,
            );
        }
    }
}

/** Project a row onto the wire shape. Never includes coordinates beyond `embedded`. */
export function toMemoryFactDto(
    fact: MemoryFact,
    extras: { score?: number | null; literalMatch?: boolean } = {},
): MemoryFactDto {
    return {
        id: fact.id,
        body: fact.body,
        status: fact.status,
        origin: fact.origin,
        scope: fact.scope,
        agentId: fact.agentId ?? null,
        pinned: fact.pinned === true,
        sourceRunId: fact.sourceRunId ?? null,
        sourceConversationId: fact.sourceConversationId ?? null,
        sourceAgentId: fact.sourceAgentId ?? null,
        recallCount: fact.recallCount ?? 0,
        lastRecalledAt: iso(fact.lastRecalledAt),
        forgottenAt: iso(fact.forgottenAt),
        restorableUntil: fact.forgottenAt ? restorableUntil(fact.forgottenAt).toISOString() : null,
        embedded: Boolean(fact.embeddedAt),
        score: extras.score ?? null,
        literalMatch: extras.literalMatch === true,
        createdAt: iso(fact.createdAt) ?? new Date(0).toISOString(),
        updatedAt: iso(fact.updatedAt) ?? new Date(0).toISOString(),
    };
}

/** Trim and bound a body; the error names the character count, never echoes the text. */
export function validateBody(raw: unknown): string {
    if (typeof raw !== 'string') {
        throw new BadRequestException({
            code: 'memory_fact_body_required',
            message: 'A fact needs some text.',
        });
    }
    const body = raw.trim();
    if (body.length === 0) {
        throw new BadRequestException({
            code: 'memory_fact_body_required',
            message: 'A fact needs some text.',
        });
    }
    if (body.length > MEMORY_FACT_BODY_MAX) {
        throw new BadRequestException({
            code: 'memory_fact_body_too_long',
            message: `A fact can be at most ${MEMORY_FACT_BODY_MAX} characters — this one is ${body.length}.`,
            length: body.length,
            max: MEMORY_FACT_BODY_MAX,
        });
    }
    return body;
}

/**
 * Load an owned fact through `facts` — the service's repository, or the
 * transaction-bound one a write lock hands out — or answer 404.
 */
async function requireOwnedIn(
    facts: MemoryFactRepository,
    actor: MemoryFactActor,
    id: string,
): Promise<MemoryFact> {
    const fact = await facts.findOwned(id, actor.userId, actor.ownership);
    if (!fact) {
        throw notFound(id);
    }
    return fact;
}

/** The exact-duplicate defence, read through `facts` (see {@link requireOwnedIn}). */
async function assertNoDuplicate(
    facts: MemoryFactRepository,
    actor: MemoryFactActor,
    body: string,
    excludeId?: string,
): Promise<void> {
    const duplicate = await facts.findLiveDuplicate(actor.userId, actor.ownership, body, excludeId);
    if (duplicate) {
        throw new ConflictException({
            code: 'memory_fact_duplicate',
            message: 'This fact is already remembered.',
            existingId: duplicate.id,
        });
    }
}

function memoryFullError(): ConflictException {
    return new ConflictException({
        code: 'memory_fact_capacity_full',
        message: `Memory is full — ${MEMORY_FACT_ACTIVE_MAX.toLocaleString('en-US')} facts is the limit. Forget some facts, or run Tidy up to merge duplicates.`,
        capacity: MEMORY_FACT_ACTIVE_MAX,
    });
}

function pinsFullError(): ConflictException {
    return new ConflictException({
        code: 'memory_fact_pins_full',
        message: `At most ${MEMORY_FACT_PINNED_MAX} facts can be pinned. Unpin one first.`,
        capacity: MEMORY_FACT_PINNED_MAX,
    });
}

function notFound(id: string): NotFoundException {
    return new NotFoundException(`Memory fact ${id} not found`);
}

function restorableUntil(forgottenAt: Date | string): Date {
    const base = forgottenAt instanceof Date ? forgottenAt : new Date(forgottenAt);
    return new Date(base.getTime() + MEMORY_FACT_FORGET_RETENTION_DAYS * DAY_MS);
}

function iso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampLimit(limit: number | undefined): number {
    if (!limit || !Number.isFinite(limit) || limit < 1) return MEMORY_FACT_LIST_LIMIT_MAX;
    return Math.min(Math.floor(limit), MEMORY_FACT_LIST_LIMIT_MAX);
}

/** Opaque page cursor. Offset-based: a workspace holds at most a few thousand rows. */
export function encodeCursor(offset: number): string {
    return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): number {
    if (!cursor) return 0;
    try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const match = /^o:(\d{1,7})$/.exec(decoded);
        return match ? Number(match[1]) : 0;
    } catch {
        return 0;
    }
}
