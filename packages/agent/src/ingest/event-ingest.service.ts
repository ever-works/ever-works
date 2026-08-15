import { Injectable, Logger, Optional } from '@nestjs/common';
import type { IngestedEventEnvelope } from '@ever-works/contracts';
import { INGEST_EVENT_PAYLOAD_MAX_BYTES } from '@ever-works/contracts';
import { ActivityLogService } from '../activity-log/activity-log.service';
import { AgentMemoryFacadeService } from '../facades/agent-memory.facade';
import { ActivityActionType, ActivityStatus } from '../entities/activity-log.types';
import type { IngestedEvent } from '../entities/ingested-event.entity';
import { IngestedEventRepository } from './ingested-event.repository';
import { WorkHintResolverService } from './work-hint-resolver.service';
import { IngestSalienceService } from './ingest-salience.service';
import { ExternalIssueLinkService } from './external-issue-link.service';

/**
 * Kinds that resolve to a DEDICATED Activity action type instead of the
 * generic `EXTERNAL_EVENT_INGESTED` (git activity ingestion, audit item
 * j).
 *
 * Every other kind is unchanged: the map is consulted with a fallback,
 * so a connector that never appears here produces byte-for-byte the row
 * it produced before this map existed.
 *
 * Two things travel with a dedicated action type:
 *
 *   * the action type itself, so the feed can say "pushed 3 commits"
 *     rather than "an external event landed"; and
 *   * the envelope `payload` copied into `activity_log.details`, because
 *     the routing block those rows are built from (repoFullName / ref /
 *     sha / prNumber / taskId) is what a renderer needs and it is NOT in
 *     the provenance `metadata` block. Generic ingested events keep
 *     provenance-only metadata and a null `details`, exactly as before —
 *     widening that for every connector would push arbitrary third-party
 *     message text into the feed payload.
 */
export const INGEST_ACTIVITY_ACTION_BY_KIND: Readonly<Record<string, ActivityActionType>> =
    Object.freeze({
        'github.push': ActivityActionType.GIT_PUSHED,
        'github.commit': ActivityActionType.GIT_COMMITTED,
        'github.merge': ActivityActionType.GIT_MERGED,
    });

export interface IngestResult {
    /** New rows written. */
    inserted: number;
    /** Envelopes dropped because their dedupe identity already landed. */
    duplicates: number;
    /** Envelopes rejected before insert (oversized payload, bad shape). */
    rejected: number;
    /**
     * Envelopes dropped by the salience filter — well-formed, just not
     * worth a feed row under the operator's configuration. Always `0`
     * when the filter is unconfigured (its default).
     */
    filtered: number;
}

export interface ProcessBatchResult {
    /** Rows marked processed this run. */
    processed: number;
    /** Activity-log rows written. */
    activities: number;
    /** Memory observations saved (0 when no provider is enabled). */
    memories: number;
    /**
     * External-issue ↔ Task links refreshed (0 when the mapping service
     * is not bound, or when no processed event was a linked issue).
     */
    issueLinks: number;
    /**
     * Rows whose REQUIRED processor (kind processor or Activity write)
     * failed — left unprocessed for retry.
     */
    failed: number;
}

/**
 * A domain processor bound to specific event kinds — e.g. the Meetings
 * feature consuming `zoom.recording` envelopes into Meeting rows.
 * Registered at boot (`registerKindProcessor`) by feature modules so
 * the spine stays dependency-free of the features it feeds.
 *
 * Contract: `process` MUST be idempotent per event — a row whose later
 * fan-out step failed is retried next tick, kind processor included.
 */
export interface IngestedEventKindProcessor {
    /**
     * Source-namespaced kinds this processor consumes. The single
     * entry `'*'` subscribes to EVERY kind (Task Triggers — matching
     * happens inside the processor against user-authored rules).
     */
    readonly kinds: readonly string[];
    process(event: IngestedEvent): Promise<void>;
}

/**
 * Event-ingest spine (Wave 6) — the ONE pipeline every connector feeds.
 *
 * `ingest()` lands normalized `IngestedEventEnvelope`s as
 * `ingested_events` rows (dedupe-insert by owner-scoped
 * `(source, sourceEventId)`); `processBatch()` — driven by the
 * `event-ingest-tick` cron — fans each unprocessed row out to:
 *
 *   1. Activity log (`EXTERNAL_EVENT_INGESTED`, or the dedicated action
 *      type in {@link INGEST_ACTIVITY_ACTION_BY_KIND} for git activity;
 *      provenance in `metadata` incl. `sourceUrl`) — REQUIRED: a failed
 *      write leaves the row unprocessed so the next tick retries it.
 *   2. Agent Memory via `AgentMemoryFacadeService.saveMemory` with
 *      provenance tags/metadata — BEST-EFFORT: no provider enabled or a
 *      provider error never fails the batch (mirrors
 *      `WorkMemoryService`, incl. the quiet `NoProviderError` case).
 *
 * Chat surfacing rides the existing Memory/Activity recall paths plus
 * the `list_recent_events` tool (`agent-ingest-tools.ts`) — answers
 * link back to the origin through `sourceUrl`.
 *
 * Wave 8 (Meetings v1): feature modules can additionally register
 * KIND-BOUND processors (`registerKindProcessor`) that run before the
 * Activity write — e.g. `zoom.recording` envelopes becoming Meeting
 * rows. A kind-processor failure is REQUIRED-grade: the row stays
 * unprocessed and retries next tick.
 *
 * Two later, deliberately OPTIONAL stages hang off the same pipeline:
 *
 *   - **Salience filter** (audit item (k)) — `IngestSalienceService`
 *     drops low-value envelopes at `ingest()` time so a chatty source
 *     cannot flood the feed. Unbound or unconfigured (its default) means
 *     nothing is filtered, i.e. byte-for-byte the previous behaviour.
 *   - **External-issue ↔ Task links** (audit item (i)) —
 *     `ExternalIssueLinkService` refreshes an existing issue↔Task link
 *     during the drain (best-effort, never creates one).
 *
 * Both are `@Optional()` constructor params appended LAST, so every
 * positional `new EventIngestService(...)` fixture keeps compiling.
 */
@Injectable()
export class EventIngestService {
    private readonly logger = new Logger(EventIngestService.name);

    /** Kind-bound domain processors (Meetings, …) — see the interface doc. */
    private readonly kindProcessors: IngestedEventKindProcessor[] = [];

    constructor(
        private readonly repository: IngestedEventRepository,
        private readonly activityLogService: ActivityLogService,
        @Optional() private readonly agentMemory?: AgentMemoryFacadeService,
        // `workId` routing — turns a connector's `workHint` into a real
        // Work for the owning user (and verifies a caller-supplied
        // `workId` actually belongs to them). Appended LAST + @Optional()
        // so every positional `new EventIngestService(...)` fixture keeps
        // compiling and ingests exactly as it did before.
        @Optional() private readonly workHints?: WorkHintResolverService,
        // Salience filter (audit item (k)) — drops low-value envelopes
        // before they reach the feed. Appended LAST + @Optional() for the
        // same reason as `workHints`; absent (or unconfigured) means
        // NOTHING is filtered, i.e. exactly the pre-filter behaviour.
        @Optional() private readonly salience?: IngestSalienceService,
        // External-issue ↔ Task links (audit item (i)). Best-effort
        // freshness stamping during the drain; absent = no-op. Appended
        // LAST + @Optional() per the same fixture-compatibility rule.
        @Optional() private readonly externalIssueLinks?: ExternalIssueLinkService,
    ) {}

    /**
     * Register a domain processor for specific event kinds. Feature
     * modules call this from `onModuleInit` (the service is a process
     * singleton, so cron-driven `processBatch` runs see it too). The
     * processor runs BEFORE the Activity write — its failure leaves the
     * row unprocessed for retry WITHOUT duplicating Activity rows.
     */
    registerKindProcessor(processor: IngestedEventKindProcessor): void {
        this.kindProcessors.push(processor);
    }

    /** Dedupe-insert a batch of envelopes for one owner. */
    async ingest(userId: string, envelopes: IngestedEventEnvelope[]): Promise<IngestResult> {
        const result: IngestResult = { inserted: 0, duplicates: 0, rejected: 0, filtered: 0 };

        for (const envelope of envelopes) {
            if (!this.isIngestible(envelope)) {
                result.rejected += 1;
                continue;
            }

            const occurredAt = new Date(envelope.occurredAt);
            if (Number.isNaN(occurredAt.getTime())) {
                result.rejected += 1;
                continue;
            }

            // Salience gate runs AFTER the structural floor so a
            // malformed envelope is still counted as `rejected`, not
            // silently reclassified as "not interesting". No filter
            // bound (or none configured) = nothing dropped.
            if (this.salience && !this.salience.isSalient(envelope)) {
                result.filtered += 1;
                continue;
            }

            const { created } = await this.repository.createIfNew({
                userId,
                organizationId: envelope.organizationId ?? null,
                workId: await this.resolveWorkId(userId, envelope),
                source: envelope.source,
                sourceEventId: envelope.sourceEventId,
                kind: envelope.kind,
                occurredAt,
                actorName: envelope.actor?.name ?? null,
                subjectType: envelope.subject?.type ?? null,
                subjectExternalId: envelope.subject?.externalId ?? null,
                title: envelope.subject?.title ?? null,
                sourceUrl: envelope.sourceUrl ?? null,
                payload: envelope.payload ?? {},
            });

            if (created) {
                result.inserted += 1;
            } else {
                result.duplicates += 1;
            }
        }

        return result;
    }

    /**
     * Decide which Work (if any) this envelope belongs to.
     *
     * Precedence: an explicit `workId` wins (verified to belong to the
     * ingesting user), then the connector's `workHint`, then null.
     * Without the resolver bound the behaviour is byte-for-byte the
     * pre-routing one — `envelope.workId ?? null`.
     */
    private async resolveWorkId(
        userId: string,
        envelope: IngestedEventEnvelope,
    ): Promise<string | null> {
        if (!this.workHints) return envelope.workId ?? null;
        if (envelope.workId) {
            const owned = await this.workHints.verifyOwnedWorkId(userId, envelope.workId);
            if (!owned) {
                this.logger.warn(
                    `Ingest: dropping workId ${envelope.workId} on ${envelope.source}/` +
                        `${envelope.sourceEventId} — not owned by user ${userId}.`,
                );
            }
            return owned;
        }
        return this.workHints.resolve(userId, envelope.workHint);
    }

    /**
     * Drain up to `limit` unprocessed rows through the processor
     * fan-out. Never throws for a single bad row — the row is either
     * retried next tick (Activity write failed) or completed.
     */
    async processBatch(limit = 50): Promise<ProcessBatchResult> {
        const result: ProcessBatchResult = {
            processed: 0,
            activities: 0,
            memories: 0,
            issueLinks: 0,
            failed: 0,
        };
        const events = await this.repository.findUnprocessed(limit);

        for (const event of events) {
            try {
                // Kind-bound domain processors run FIRST (before the
                // Activity write) so a processor failure retries the row
                // next tick without duplicating Activity rows. Processors
                // are idempotent by contract, so the inverse ordering
                // hazard (processor reran after a later step failed) is
                // safe.
                await this.runKindProcessors(event);
            } catch (error) {
                result.failed += 1;
                this.logger.warn(
                    `Kind processor failed for ingested event ${event.id} (${event.kind}): ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                continue;
            }

            try {
                await this.writeActivity(event);
                result.activities += 1;
            } catch (error) {
                // REQUIRED processor failed — leave the row unprocessed so
                // the next tick retries it, and keep draining the batch.
                result.failed += 1;
                this.logger.warn(
                    `Activity write failed for ingested event ${event.id}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
                continue;
            }

            if (await this.trySaveMemory(event)) {
                result.memories += 1;
            }

            // External-issue ↔ Task freshness — best-effort, never fails
            // the batch, never creates a link (see the service doc).
            if (this.externalIssueLinks) {
                if (await this.externalIssueLinks.tryRecordEvent(event)) {
                    result.issueLinks += 1;
                }
            }

            await this.repository.markProcessed(event.id);
            result.processed += 1;
        }

        return result;
    }

    /** Run every registered processor whose kinds include this event's (or `'*'`). */
    private async runKindProcessors(event: IngestedEvent): Promise<void> {
        for (const processor of this.kindProcessors) {
            if (processor.kinds.includes('*') || processor.kinds.includes(event.kind)) {
                await processor.process(event);
            }
        }
    }

    private async writeActivity(event: IngestedEvent): Promise<void> {
        // Kinds with a dedicated action type (git activity) also carry
        // their routing payload into `details`; everything else keeps the
        // pre-existing generic row, provenance-only.
        const dedicatedAction = INGEST_ACTIVITY_ACTION_BY_KIND[event.kind];
        await this.activityLogService.log(
            {
                userId: event.userId,
                ...(event.workId ? { workId: event.workId } : {}),
                actionType: dedicatedAction ?? ActivityActionType.EXTERNAL_EVENT_INGESTED,
                action: event.kind,
                status: ActivityStatus.COMPLETED,
                summary: this.summarize(event),
                ...(dedicatedAction && event.payload ? { details: event.payload } : {}),
                metadata: this.provenance(event),
            },
            // Feed orders by "when it happened", not "when the platform
            // drained it" — same rule as ingestFromWebsite. Future
            // timestamps are clamped there too; ingest validates
            // occurredAt at the edge, clamp defensively anyway.
            { createdAt: event.occurredAt > new Date() ? new Date() : event.occurredAt },
        );
    }

    /**
     * Memory observation — best-effort, never fails the batch. Returns
     * true when an observation was saved. `NoProviderError` (no
     * agent-memory provider enabled for this user/Work) is the expected
     * quiet case — debug, not warn (see WorkMemoryService rationale).
     */
    private async trySaveMemory(event: IngestedEvent): Promise<boolean> {
        if (!this.agentMemory) {
            return false;
        }

        const facadeOptions = {
            userId: event.userId,
            ...(event.workId ? { workId: event.workId } : {}),
        };

        try {
            await this.agentMemory.saveMemory(
                {
                    content: this.summarize(event),
                    tags: [
                        'ingested-event',
                        `source:${event.source}`,
                        `kind:${event.kind}`,
                        ...(event.workId ? [`work:${event.workId}`] : []),
                    ],
                    // Provenance metadata is REQUIRED on ingest-written
                    // memories — it drives the Memory source facets and
                    // lets chat citations carry the sourceUrl.
                    metadata: this.provenance(event),
                },
                facadeOptions,
            );
            return true;
        } catch (error) {
            const isNoProvider = error instanceof Error && error.name === 'NoProviderError';
            const message = `Memory write skipped for ingested event ${event.id}: ${
                error instanceof Error ? error.message : String(error)
            }`;
            if (isNoProvider) {
                this.logger.debug(message);
            } else {
                this.logger.warn(message);
            }
            return false;
        }
    }

    private summarize(event: IngestedEvent): string {
        const parts = [
            event.actorName ? `${event.actorName}:` : null,
            event.kind,
            event.title ? `— ${event.title}` : null,
        ].filter(Boolean);
        const summary = parts.join(' ');
        // activity_log.summary is varchar(500); stay safely under it.
        return summary.length > 480 ? summary.slice(0, 480) : summary;
    }

    private provenance(event: IngestedEvent): Record<string, unknown> {
        return {
            ingestedEventId: event.id,
            source: event.source,
            sourceEventId: event.sourceEventId,
            kind: event.kind,
            occurredAt: event.occurredAt.toISOString(),
            ...(event.sourceUrl ? { sourceUrl: event.sourceUrl } : {}),
            ...(event.actorName ? { actorName: event.actorName } : {}),
            ...(event.subjectType ? { subjectType: event.subjectType } : {}),
            ...(event.subjectExternalId ? { subjectExternalId: event.subjectExternalId } : {}),
            ...(event.title ? { title: event.title } : {}),
            ...(event.organizationId ? { organizationId: event.organizationId } : {}),
        };
    }

    /** Structural floor + defensive payload cap (DTO enforces at the edge). */
    private isIngestible(envelope: IngestedEventEnvelope): boolean {
        if (!envelope || typeof envelope !== 'object') return false;
        if (!envelope.source || !envelope.sourceEventId || !envelope.kind) return false;
        if (envelope.payload !== undefined && envelope.payload !== null) {
            if (typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
                return false;
            }
            try {
                const bytes = Buffer.byteLength(JSON.stringify(envelope.payload), 'utf8');
                if (bytes > INGEST_EVENT_PAYLOAD_MAX_BYTES) return false;
            } catch {
                return false;
            }
        }
        return true;
    }
}
