import { Injectable, Logger, Optional } from '@nestjs/common';
import { AgentMemoryFacadeService } from '../facades/agent-memory.facade';
import type { Work } from '../entities/work.entity';

/**
 * What a Work run learned, written into the shared Memory.
 *
 * Agents already open a memory session per run
 * (`AgentRunService.tryOpenMemorySession`) so their findings survive the
 * session that produced them. Scheduled Work runs did not: a Work could
 * research a topic every night for a month and retain nothing — each run
 * started from zero, re-derived the same conclusions, and threw them away.
 *
 * This service closes that gap using the same `agent-memory` plugin
 * capability, so Work memories land in the same store agents read from and
 * are searchable alongside them.
 *
 * Everything here is **best-effort and never throws**. A generation run that
 * succeeded must not be reported as failed because a memory provider was
 * unreachable — the run's own output is already committed to git by this
 * point.
 */
export interface WorkRunMemoryInput {
    readonly work: Pick<Work, 'id' | 'name' | 'slug' | 'kind' | 'userId'>;
    /** Owner of the run — scopes provider resolution. */
    readonly userId: string;
    /** Human-readable account of what this run did. */
    readonly summary: string;
    /** Generation-history row this memory describes, for traceability. */
    readonly historyId?: string;
    readonly scheduleId?: string;
    readonly stats?: {
        readonly newItems?: number;
        readonly updatedItems?: number;
        readonly totalItems?: number;
    };
}

@Injectable()
export class WorkMemoryService {
    private readonly logger = new Logger(WorkMemoryService.name);

    constructor(@Optional() private readonly agentMemory?: AgentMemoryFacadeService) {}

    /**
     * Record one Work run in Memory: open a session, save the finding,
     * close the session.
     *
     * Mirrors `AgentRunService.tryOpenMemorySession` deliberately, including
     * NOT calling `isConfigured()` first — that check is registry-global
     * (true whenever any agent-memory plugin is loaded, regardless of user
     * enablement), so it false-positives and produces a warning on every
     * run for users who have no provider enabled. `openSession` does the
     * real resolution and throws `NoProviderError`, which is the expected
     * quiet case.
     */
    async recordRun(input: WorkRunMemoryInput): Promise<string | null> {
        if (!this.agentMemory) {
            return null;
        }

        const { work, userId, summary } = input;
        // `workId` scopes provider resolution to the Work's own configured
        // memory provider and its Work-level settings, falling back to the
        // user's. Without it a Work would write into a different store from
        // the one its own agents read.
        const facadeOptions = { userId, workId: work.id };

        let sessionId: string | null = null;
        try {
            const session = await this.agentMemory.openSession(
                {
                    source: 'work-run',
                    workId: work.id,
                    workName: work.name,
                    workSlug: work.slug,
                    workKind: work.kind,
                    ...(input.historyId ? { historyId: input.historyId } : {}),
                    ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
                },
                facadeOptions,
            );
            sessionId = session.id;

            await this.agentMemory.saveMemory(
                {
                    content: summary,
                    // Tags are what make a Work's own history retrievable
                    // later: `work:<id>` narrows to this Work, `work-run`
                    // separates scheduled output from agent chatter, and the
                    // kind lets a query span every Work of a type.
                    tags: ['work-run', `work:${work.id}`, `kind:${work.kind ?? 'default'}`],
                    metadata: {
                        workId: work.id,
                        workSlug: work.slug,
                        ...(input.historyId ? { historyId: input.historyId } : {}),
                        ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
                        ...(input.stats ? { stats: input.stats } : {}),
                    },
                    sessionId,
                },
                facadeOptions,
            );

            return sessionId;
        } catch (error) {
            this.logFailure(error, work.id);
            return null;
        } finally {
            if (sessionId) {
                // Closing is its own try/catch: a save that succeeded must
                // not be reported as a failure because the close call
                // afterwards did not land.
                try {
                    await this.agentMemory.closeSession(sessionId, facadeOptions);
                } catch (error) {
                    this.logFailure(error, work.id, 'close');
                }
            }
        }
    }

    /**
     * Retrieve what this Work has learned previously.
     *
     * Returns an empty array rather than throwing when no provider is
     * configured, so callers can inject prior findings into a prompt without
     * branching on whether Memory exists.
     */
    async recall(input: {
        work: Pick<Work, 'id'>;
        userId: string;
        query: string;
        limit?: number;
    }): Promise<Array<{ content: string; score?: number }>> {
        if (!this.agentMemory) {
            return [];
        }

        try {
            const response = await this.agentMemory.searchMemory(
                {
                    query: input.query,
                    limit: input.limit ?? 10,
                    tags: [`work:${input.work.id}`],
                },
                { userId: input.userId, workId: input.work.id },
            );
            return (response?.results ?? []).map((result) => ({
                content: result.content,
                ...(typeof result.score === 'number' ? { score: result.score } : {}),
            }));
        } catch (error) {
            this.logFailure(error, input.work.id, 'search');
            return [];
        }
    }

    private logFailure(error: unknown, workId: string, operation = 'record'): void {
        // `NoProviderError` is the expected case for users with no
        // agent-memory provider enabled — debug, not warn, so it does not
        // fill ops logs on every scheduled run.
        const isNoProvider = error instanceof Error && error.name === 'NoProviderError';
        const message = `WorkMemoryService: ${operation} failed for work ${workId}: ${
            error instanceof Error ? error.message : String(error)
        }`;
        if (isNoProvider) {
            this.logger.debug(message);
        } else {
            this.logger.warn(message);
        }
    }
}
