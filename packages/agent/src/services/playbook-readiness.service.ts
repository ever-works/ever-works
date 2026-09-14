import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    PLAYBOOK_ADOPTION_CEILING,
    PLAYBOOK_COPY_LIMIT,
    PLAYBOOK_READINESS_BUDGET_MS,
    PLAYBOOK_READINESS_CACHE_MS,
    type PlaybookBlocker,
    type PlaybookCapabilityProvider,
    type PlaybookCatalogEntry,
    type PlaybookConnectionStatus,
    type PlaybookNameCollision,
    type PlaybookReadiness,
    type PlaybookReadinessState,
} from '@ever-works/contracts';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { AgentRepository } from '../database/repositories/agent.repository';

/**
 * Port for the adoption counts readiness needs (the workspace ceiling and
 * the per-playbook copy limit). Nothing binds it until adoptions exist, so
 * both counts read as 0 — which is the truth before the first adoption.
 */
export interface PlaybookAdoptionCounts {
    countRunning(userId: string): Promise<number>;
    countCopies(userId: string, slug: string): Promise<number>;
}

export const PLAYBOOK_ADOPTION_COUNTS = Symbol('PLAYBOOK_ADOPTION_COUNTS');

export interface PlaybookReadinessScope {
    readonly userId: string;
    readonly workId?: string;
}

export interface PlaybookReadinessOptions {
    /** Resolve the Agent-name collision too (preflight and detail, not the list). */
    readonly checkNameCollision?: boolean;
    /** The Agent name the setup would create; defaults to the playbook's own. */
    readonly agentName?: string;
}

interface CacheEntry<T> {
    readonly value: T;
    readonly expiresAt: number;
}

const UNRESOLVED = Symbol('unresolved');
/** How far down the "Name 2, Name 3 …" sequence a suggestion looks. */
const MAX_NAME_SUFFIX = 50;
/** Bounds each in-memory cache so a busy replica cannot grow it without limit. */
const MAX_CACHE_ENTRIES = 5000;

/**
 * Capability & playbook catalogue (AW-21) — whether THIS workspace can run a
 * playbook right now.
 *
 * Read-only by construction: it asks the plugin registry which enabled
 * plugin provides each capability a playbook needs, counts adoptions through
 * a port, and looks for an Agent-name collision. It never creates, enables,
 * installs or writes anything.
 *
 * Every answer is cached for at most 60 s per scope so enabling a plugin
 * shows up within a minute, and every check runs inside a 2 s budget — a
 * check that has not answered by then is reported as `unknown` (and that
 * partial answer is never cached) instead of hanging the page.
 */
@Injectable()
export class PlaybookReadinessService {
    private readonly logger = new Logger(PlaybookReadinessService.name);
    private readonly cache = new Map<string, CacheEntry<PlaybookReadiness>>();
    private readonly providerCache = new Map<
        string,
        CacheEntry<PlaybookCapabilityProvider | null>
    >();

    constructor(
        private readonly registry: PluginRegistryService,
        @Optional() private readonly agents?: AgentRepository,
        @Optional()
        @Inject(PLAYBOOK_ADOPTION_COUNTS)
        private readonly adoptionCounts?: PlaybookAdoptionCounts,
    ) {}

    private now(): number {
        return Date.now();
    }

    async getReadiness(
        entry: PlaybookCatalogEntry,
        scope: PlaybookReadinessScope,
        options: PlaybookReadinessOptions = {},
    ): Promise<PlaybookReadiness> {
        const agentName = options.agentName?.trim() || entry.provision.agentName;
        const key = [
            scope.userId,
            scope.workId ?? '',
            entry.slug,
            entry.version,
            options.checkNameCollision ? `name:${agentName.toLowerCase()}` : '',
        ].join('|');
        const cached = this.cache.get(key);
        if (cached && cached.expiresAt > this.now()) return cached.value;

        const unknown: string[] = [];
        const [connections, counts, collisions] = await Promise.all([
            this.withinBudget(this.resolveConnections(entry, scope)),
            this.withinBudget(this.countAdoptions(scope.userId, entry.slug)),
            options.checkNameCollision
                ? this.withinBudget(this.findNameCollision(scope.userId, agentName))
                : Promise.resolve<PlaybookNameCollision[]>([]),
        ]);

        let resolvedConnections: PlaybookConnectionStatus[];
        if (connections === UNRESOLVED) {
            unknown.push('connections');
            // Cautious: an unanswered check never reads as satisfied.
            resolvedConnections = entry.connections.map((need) => ({
                ...need,
                satisfiedBy: null,
            }));
        } else {
            resolvedConnections = connections;
        }

        let running = 0;
        let copies = 0;
        if (counts === UNRESOLVED) {
            unknown.push('adoptions');
        } else {
            running = counts.running;
            copies = counts.copies;
        }

        let resolvedCollisions: PlaybookNameCollision[] = [];
        if (collisions === UNRESOLVED) {
            unknown.push('agent_name');
        } else {
            resolvedCollisions = collisions;
        }

        const missingRequired = resolvedConnections
            .filter((status) => status.required && !status.satisfiedBy)
            .map((status) => status.capability);

        const blockers: PlaybookBlocker[] = [];
        if (running >= PLAYBOOK_ADOPTION_CEILING) {
            blockers.push({
                code: 'adoption_ceiling',
                currentCount: running,
                limit: PLAYBOOK_ADOPTION_CEILING,
            });
        }
        if (copies >= PLAYBOOK_COPY_LIMIT) {
            blockers.push({ code: 'copy_limit', currentCount: copies, limit: PLAYBOOK_COPY_LIMIT });
        }

        const readiness: PlaybookReadiness = {
            state: this.stateFor(missingRequired.length, blockers.length, copies),
            connections: resolvedConnections,
            missingRequired,
            blockers,
            collisions: resolvedCollisions,
            unknown,
        };

        if (unknown.length === 0) {
            this.prune(this.cache);
            this.cache.set(key, {
                value: readiness,
                expiresAt: this.now() + PLAYBOOK_READINESS_CACHE_MS,
            });
        }
        return readiness;
    }

    /** Forget every cached answer — for a caller that knows plugin state just changed. */
    clear(): void {
        this.cache.clear();
        this.providerCache.clear();
    }

    /** Drop expired answers once a cache grows large, and everything if it is still full. */
    private prune<T>(cache: Map<string, CacheEntry<T>>): void {
        if (cache.size < MAX_CACHE_ENTRIES) return;
        const now = this.now();
        for (const [key, entry] of cache) {
            if (entry.expiresAt <= now) cache.delete(key);
        }
        if (cache.size >= MAX_CACHE_ENTRIES) cache.clear();
    }

    private stateFor(missing: number, blockers: number, copies: number): PlaybookReadinessState {
        if (missing > 0) return 'needs_connection';
        if (blockers > 0) return 'blocked';
        if (copies > 0) return 'adopted';
        return 'ready';
    }

    private async resolveConnections(
        entry: PlaybookCatalogEntry,
        scope: PlaybookReadinessScope,
    ): Promise<PlaybookConnectionStatus[]> {
        return Promise.all(
            entry.connections.map(async (need) => ({
                ...need,
                satisfiedBy: await this.providerFor(need.capability, scope),
            })),
        );
    }

    /** The enabled plugin that provides a capability in this scope, as display data. */
    private async providerFor(
        capability: string,
        scope: PlaybookReadinessScope,
    ): Promise<PlaybookCapabilityProvider | null> {
        const key = `${scope.userId}|${scope.workId ?? ''}|${capability}`;
        const cached = this.providerCache.get(key);
        if (cached && cached.expiresAt > this.now()) return cached.value;

        const enabled = await this.registry.getEnabledPluginsScoped(
            capability,
            scope.workId,
            scope.userId,
        );
        const preferred =
            enabled.find((p) => p.manifest.defaultForCapabilities?.includes(capability)) ??
            enabled[0];
        const value = preferred
            ? {
                  pluginId: preferred.plugin.id,
                  name: preferred.manifest.name ?? preferred.plugin.name ?? preferred.plugin.id,
              }
            : null;
        this.prune(this.providerCache);
        this.providerCache.set(key, { value, expiresAt: this.now() + PLAYBOOK_READINESS_CACHE_MS });
        return value;
    }

    private async countAdoptions(
        userId: string,
        slug: string,
    ): Promise<{ running: number; copies: number }> {
        if (!this.adoptionCounts) return { running: 0, copies: 0 };
        const [running, copies] = await Promise.all([
            this.adoptionCounts.countRunning(userId),
            this.adoptionCounts.countCopies(userId, slug),
        ]);
        return { running, copies };
    }

    /**
     * When an Agent with the target name already exists for this user, suggest
     * the first free `"<name> 2"`, `"<name> 3"`, … so setup never fails at
     * write time on a name the person could not see coming.
     */
    private async findNameCollision(
        userId: string,
        requested: string,
    ): Promise<PlaybookNameCollision[]> {
        if (!this.agents) return [];
        const { rows } = await this.agents.findByUserIdScoped(userId, {
            search: requested,
            limit: 200,
        });
        const taken = new Set(rows.map((agent) => agent.name.trim().toLowerCase()));
        if (!taken.has(requested.toLowerCase())) return [];
        for (let suffix = 2; suffix <= MAX_NAME_SUFFIX; suffix++) {
            const candidate = `${requested} ${suffix}`;
            if (!taken.has(candidate.toLowerCase())) {
                return [{ type: 'agent_name', requested, suggested: candidate }];
            }
        }
        return [{ type: 'agent_name', requested, suggested: `${requested} ${this.now()}` }];
    }

    private async withinBudget<T>(work: Promise<T>): Promise<T | typeof UNRESOLVED> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<typeof UNRESOLVED>((resolve) => {
            timer = setTimeout(() => resolve(UNRESOLVED), PLAYBOOK_READINESS_BUDGET_MS);
        });
        try {
            const guarded = work.catch((err: unknown): typeof UNRESOLVED => {
                this.logger.warn(
                    `Playbook readiness check failed: ${err instanceof Error ? err.message : err}`,
                );
                return UNRESOLVED;
            });
            return await Promise.race<T | typeof UNRESOLVED>([guarded, timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }
}
