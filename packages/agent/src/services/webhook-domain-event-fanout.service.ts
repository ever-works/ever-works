import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnApplicationBootstrap,
    type OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
    type DomainEventEnvelope,
    matchesAnyDomainEventPattern,
    RECIPIENT_EVENT_SCOPES,
    recipientScopeForEventType,
} from '@ever-works/contracts';
import { WebhookDeliveryRepository } from '../database/repositories/webhook-delivery.repository';
import { WebhookSubscriptionRepository } from '../database/repositories/webhook-subscription.repository';
import { seqToBigInt } from '../domain-events/domain-event-envelope';
import {
    DomainEventCursorExpiredError,
    DomainEventFeedService,
} from '../domain-events/domain-event-feed.service';
import { PLUGIN_EVENT_ANCHOR_TENANT_ID } from '../domain-events/domain-event-plugin-delivery.service';
import { DomainEventRelayService } from '../domain-events/domain-event-relay.service';
import { DomainEvent } from '../entities/domain-event.entity';
import { PluginEventCursor } from '../entities/plugin-event-cursor.entity';
import type { WebhookSubscription } from '../entities/webhook-subscription.entity';
import { type WebhookOwnerAccess, WebhookOwnerAccessService } from './webhook-owner-access.service';

/**
 * Enqueues a `webhook_deliveries` row the fan-out created on the platform's
 * delivery pipeline (the API binds it to `WebhookEventDispatcherService`:
 * Trigger.dev `webhook-delivery`, or in process).
 */
export interface WebhookV2Enqueuer {
    enqueueDelivery(payload: {
        readonly deliveryId: string;
        readonly subscriptionId: string;
        readonly eventName: string;
        readonly payload: Record<string, unknown>;
    }): Promise<unknown>;
}

/** DI token for {@link WebhookV2Enqueuer}. Unbound → deliveries are created but not enqueued. */
export const WEBHOOK_V2_ENQUEUER = Symbol.for('WebhookV2Enqueuer');

/**
 * The in-process retry ladder (F45): 30 s after the first failed attempt, then x6 per
 * attempt (3 min, 18 min, 1.8 h, 10.8 h), at most 24 h — the curve the Trigger.dev
 * `webhook-delivery` task uses (`minTimeoutInMs: 30_000, factor: 6`).
 */
export function webhookRetryDelayMs(attempts: number): number {
    const step = Math.max(1, Math.trunc(attempts));
    return Math.min(30_000 * 6 ** (step - 1), 24 * 60 * 60 * 1000);
}

/** The attempt budget (`WEBHOOK_MAX_CONSECUTIVE_FAILURES`, default 10), as the Trigger.dev task. */
function webhookMaxAttempts(): number {
    const n = Number.parseInt(process.env.WEBHOOK_MAX_CONSECUTIVE_FAILURES ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 10;
}

/** The fan-out's cursor row in `plugin_event_cursors` (one global position, anchor tenant). */
export const WEBHOOKS_V2_CURSOR_ID = 'core:webhooks-v2';

/** Events read per page, and pages per pass (a pass yields after this many). */
const PAGE_SIZE = 200;
const MAX_PAGES_PER_PASS = 25;
/** The leader's catch-up timer: picks up anything a crash or a slow pass left behind. */
const CATCH_UP_INTERVAL_MS = 10_000;

/** A pending delivery the fan-out created but never enqueued (crash in between) is re-enqueued after this. */
const UNSENT_GRACE_MS = 5 * 60 * 1000;
const UNSENT_BATCH = 100;

/**
 * Webhooks v2 fan-out (EW-P1-5, integration contract v1 B.5).
 *
 * Turns dispatched domain events into `webhook_deliveries` for every active
 * `version = 2` subscription they match, then enqueues them on the existing
 * delivery pipeline (Trigger.dev `webhook-delivery`, or in process), which
 * signs them `X-Ever-Works-Signature: t=,v1=` and retries 5xx / timeouts on the
 * 30 s → 24 h ladder.
 *
 * **At least once, idempotent.** The fan-out reads the change feed from its own
 * cursor (`plugin_event_cursors`, plugin id {@link WEBHOOKS_V2_CURSOR_ID}) and
 * only moves it after the page's deliveries exist; the unique
 * `(subscriptionId, eventId)` index turns a re-run into a no-op. It runs on the
 * relay leader: as a relay consumer right after each dispatch (low latency) and
 * on a 10 s catch-up timer (a crash between dispatch and fan-out loses nothing).
 *
 * **What a subscription receives** — exactly what the integration feed would
 * serve its owner, restricted by the subscription:
 *  - events of its `organizationIds` (never personal scope, never `private`
 *    aggregates except the id-only `*.visibility_changed` notice — the feed's
 *    rules, applied by {@link DomainEventFeedService});
 *  - whose type matches its `events` (opt-in types only by exact name);
 *  - whose `origin.tag` is not in its `excludeOriginTags` (loop guard);
 *  - of a recipient-scoped domain (`inbox.*`, `email.*`: one person's messages)
 *    only when its owner is an integration key holding that domain's read scope;
 *  - that occurred after the subscription was created;
 *  - while its owner still has access: a user owner must still be a member of
 *    the event's organization and able to read the event's record in the app
 *    (`WebhookOwnerAccessService.userMayRead`: `visibleTo` for tasks, goals,
 *    missions, ideas and agents, Work access for works); an integration-key
 *    owner must be active, unexpired and still pinned to the event's
 *    organization. A subscription whose owner is gone or revoked is marked
 *    `disabled`.
 */
@Injectable()
export class WebhookDomainEventFanoutService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(WebhookDomainEventFanoutService.name);
    private timer: NodeJS.Timeout | null = null;
    private inFlight: Promise<number> | null = null;
    private rerun = false;

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly subscriptions: WebhookSubscriptionRepository,
        private readonly deliveries: WebhookDeliveryRepository,
        private readonly feed: DomainEventFeedService,
        private readonly ownerAccess: WebhookOwnerAccessService,
        @Optional()
        @Inject(WEBHOOK_V2_ENQUEUER)
        private readonly enqueuer?: WebhookV2Enqueuer,
        @Optional() private readonly relay?: DomainEventRelayService,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.relay) return;
        this.relay.registerConsumer({
            name: 'webhooks-v2',
            // The batch itself is not needed: the pass reads from the cursor, so it
            // also covers anything an earlier pass missed. Review 2026-10-17 F44: never
            // awaited — a long pass (thousands of deliveries) held every relay batch for
            // the listener timeout; started here, it loses nothing (own cursor).
            consume: async () => {
                void this.catchUp().catch((error) =>
                    this.logger.warn(`webhooks v2 fan-out failed: ${describe(error)}`),
                );
            },
        });
        if (process.env.NODE_ENV === 'test') return;
        this.timer = setInterval(() => {
            if (!this.relay?.isLeader()) return;
            void this.catchUp().catch((error) =>
                this.logger.warn(`webhooks v2 catch-up failed: ${describe(error)}`),
            );
        }, CATCH_UP_INTERVAL_MS);
        this.timer.unref?.();
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /**
     * One fan-out pass from the cursor (single-flight: a call while a pass runs
     * schedules one more pass and shares the running one). Returns the number
     * of deliveries created.
     */
    catchUp(): Promise<number> {
        if (this.inFlight) {
            this.rerun = true;
            return this.inFlight;
        }
        const run = (async () => {
            let created = 0;
            do {
                this.rerun = false;
                created += await this.pass();
            } while (this.rerun);
            return created;
        })().finally(() => {
            this.inFlight = null;
        });
        this.inFlight = run;
        return run;
    }

    private async pass(): Promise<number> {
        // Review 2026-10-17 F43: the head BEFORE the subscriptions are listed is this
        // pass's ceiling. A subscription created or changed after the list was read
        // starts at (or matches from) a later head, so events above the ceiling are left
        // to the next pass, which reads the list again.
        const ceiling = await this.feed.head();
        const subscriptions = (await this.subscriptions.listActiveV2()).filter(
            (sub) => (sub.organizationIds?.length ?? 0) > 0 && (sub.events?.length ?? 0) > 0,
        );
        const cursor = await this.loadCursor(subscriptions);
        if (subscriptions.length === 0) {
            // Nobody listens: keep the cursor at the head so a new subscription
            // starts from now, not from the whole retained history.
            await this.moveCursor(cursor, ceiling);
            return 0;
        }

        const organizationIds = [
            ...new Set(subscriptions.flatMap((sub) => sub.organizationIds ?? [])),
        ];
        const patterns = [...new Set(subscriptions.flatMap((sub) => sub.events ?? []))];
        const owners = new Map<string, WebhookOwnerAccess>();
        const reads = new Map<string, Promise<boolean>>();
        let after = cursor.lastSeq;
        let created = 0;

        for (let page = 0; page < MAX_PAGES_PER_PASS; page++) {
            let result;
            try {
                result = await this.feed.readPage({
                    organizationIds,
                    after,
                    upTo: ceiling,
                    limit: PAGE_SIZE,
                    types: patterns,
                    // Read the recipient-scoped domains too; each subscription is
                    // gated on its owner's scopes below.
                    grantedScopes: RECIPIENT_EVENT_SCOPES,
                });
            } catch (error) {
                if (error instanceof DomainEventCursorExpiredError) {
                    // Retention purged events this fan-out never saw (the API was down
                    // longer than the window). Receivers fill such gaps from GET /events.
                    this.logger.warn(
                        `webhooks v2 fan-out fell behind retention (cursor ${after}, floor ${error.floor}); skipping ahead`,
                    );
                    after = error.floor;
                    await this.moveCursor(cursor, after);
                    continue;
                }
                throw error;
            }

            for (const event of result.events) {
                for (const sub of subscriptions) {
                    if (!this.matches(sub, event)) continue;
                    const owner = await this.ownerVerdict(sub, owners);
                    if (!owner.ok || !owner.organizationIds.has(event.organizationId ?? ''))
                        continue;
                    // One person's messages (`inbox.*`, `email.*`): only to an
                    // integration key holding the domain's read scope — never to a
                    // user-owned subscription (another member's inbox).
                    const recipientScope = recipientScopeForEventType(event.type);
                    if (recipientScope && !owner.scopes?.has(recipientScope)) continue;
                    // A user owner (Settings → Webhooks) receives only what it could
                    // read in the app: no Team-only records of Teams it is not on, no
                    // Works it cannot open (review 2026-10-17 F2 / F3).
                    if (owner.userId && !(await this.userMayRead(owner.userId, event, reads))) {
                        continue;
                    }
                    if (await this.deliver(sub, event)) created += 1;
                }
            }

            if (result.nextCursor) {
                after = result.nextCursor;
                await this.moveCursor(cursor, after);
            }
            if (!result.hasMore) break;
        }
        await this.recoverUnsent().catch((error) =>
            this.logger.warn(
                `webhooks v2 recovery of unsent deliveries failed: ${describe(error)}`,
            ),
        );
        await this.retryInProcess().catch((error) =>
            this.logger.warn(`webhooks v2 in-process retries failed: ${describe(error)}`),
        );
        return created;
    }

    /** The subscription's own filters (organization, type pattern, origin loop guard, creation time). */
    private matches(sub: WebhookSubscription, event: DomainEventEnvelope): boolean {
        if (!event.organizationId || !(sub.organizationIds ?? []).includes(event.organizationId)) {
            return false;
        }
        if (!matchesAnyDomainEventPattern(event.type, sub.events ?? [])) return false;
        if (event.origin.tag && (sub.excludeOriginTags ?? []).includes(event.origin.tag)) {
            return false;
        }
        // Only events after the subscription existed: exactly by feed position
        // when it recorded one, else by its creation time.
        if (sub.startAfterSeq !== null && sub.startAfterSeq !== undefined) {
            return seqToBigInt(event.seq) > seqToBigInt(sub.startAfterSeq);
        }
        const createdAt = sub.createdAt instanceof Date ? sub.createdAt.getTime() : 0;
        return Date.parse(event.occurredAt) >= createdAt;
    }

    /** Whether a user owner may read the event's record (cached per pass: one user, many subscriptions). */
    private userMayRead(
        userId: string,
        event: DomainEventEnvelope,
        cache: Map<string, Promise<boolean>>,
    ): Promise<boolean> {
        const key = `${userId}:${event.id}`;
        let verdict = cache.get(key);
        if (!verdict) {
            verdict = this.ownerAccess.userMayRead(userId, event);
            cache.set(key, verdict);
        }
        return verdict;
    }

    /** Whether the owner may still receive the subscription's events (cached per pass). */
    private async ownerVerdict(
        sub: WebhookSubscription,
        cache: Map<string, WebhookOwnerAccess>,
    ): Promise<WebhookOwnerAccess> {
        const cached = cache.get(sub.id);
        if (cached) return cached;
        const verdict = await this.ownerAccess.resolve(sub);
        if (!verdict.ok && verdict.disable) {
            await this.subscriptions.markDisabled(sub.id);
            this.logger.warn(
                `webhooks v2 subscription ${sub.id} disabled: its ${sub.ownerType} owner no longer has access`,
            );
        }
        cache.set(sub.id, verdict);
        return verdict;
    }

    /**
     * Re-enqueue fan-out deliveries that exist but were never handed to the
     * pipeline (the process stopped between creating the row and enqueueing
     * it): still `pending`, never attempted, no Trigger run, older than
     * {@link UNSENT_GRACE_MS}. The send path re-checks the subscription and
     * its owner, so a stale row for a paused or revoked subscription is
     * settled there, not sent.
     */
    private async recoverUnsent(): Promise<number> {
        const rows = await this.deliveries.listUnsentFanout(
            new Date(Date.now() - UNSENT_GRACE_MS),
            UNSENT_BATCH,
        );
        for (const row of rows) {
            if (!this.enqueuer) break;
            await this.enqueuer.enqueueDelivery({
                deliveryId: row.id,
                subscriptionId: row.subscriptionId,
                eventName: row.event,
                payload: row.payload,
            });
        }
        return this.enqueuer ? rows.length : 0;
    }

    /**
     * Review 2026-10-17 F45: without Trigger.dev, a delivery runs in process once and
     * nothing re-runs it after a 5xx or a timeout (Trigger.dev's retry policy is the
     * ladder there). A v2 delivery the in-process path left `retrying` (no Trigger run
     * id) is enqueued again once its step of the 30 s → 24 h ladder has passed, within
     * the attempt budget. The claim moves `lastAttemptAt` first, so a second pass (or
     * another replica) does not send it twice; a send that dies is retried a step later.
     */
    private async retryInProcess(): Promise<number> {
        if (!this.enqueuer) return 0;
        const now = Date.now();
        const budget = webhookMaxAttempts();
        let sent = 0;
        // One query per ladder step, each returning only rows already due at that step:
        // a row that waits on a long step (or is past the budget) never crowds out a due one.
        for (let attempts = 1; attempts < budget && sent < UNSENT_BATCH; attempts++) {
            const dueBefore = new Date(now - webhookRetryDelayMs(attempts));
            const rows = await this.deliveries.listRetryingFanout(
                attempts,
                dueBefore,
                UNSENT_BATCH - sent,
            );
            for (const row of rows) {
                if (!(await this.deliveries.claimRetry(row.id, dueBefore))) continue;
                await this.enqueuer.enqueueDelivery({
                    deliveryId: row.id,
                    subscriptionId: row.subscriptionId,
                    eventName: row.event,
                    payload: row.payload,
                });
                sent += 1;
            }
        }
        return sent;
    }

    /** Create the pending delivery (idempotent) and enqueue it. */
    private async deliver(sub: WebhookSubscription, event: DomainEventEnvelope): Promise<boolean> {
        const payload = event as unknown as Record<string, unknown>;
        const delivery = await this.deliveries.createPendingForEvent({
            subscriptionId: sub.id,
            accountId: sub.accountId,
            event: event.type,
            eventId: event.id,
            payload,
            tenantId: event.tenantId,
            organizationId: event.organizationId,
        });
        if (!delivery) return false;
        if (!this.enqueuer) {
            this.logger.warn(
                `webhooks v2 delivery ${delivery.id} created but no enqueuer is bound`,
            );
            return true;
        }
        await this.enqueuer.enqueueDelivery({
            deliveryId: delivery.id,
            subscriptionId: sub.id,
            eventName: event.type,
            payload,
        });
        return true;
    }

    // ── cursor ─────────────────────────────────────────────────────────────

    /**
     * The fan-out's cursor row. Created on first use at the lowest
     * `startAfterSeq` of the active subscriptions (or, for rows without one,
     * just before the first event after the oldest was created; at the head
     * when there is none), so the batch whose dispatch triggered the very first
     * pass is not skipped.
     */
    private async loadCursor(
        subscriptions: readonly WebhookSubscription[],
    ): Promise<{ id: string; lastSeq: string }> {
        const repo = this.dataSource.getRepository(PluginEventCursor);
        const where = { pluginId: WEBHOOKS_V2_CURSOR_ID, tenantId: PLUGIN_EVENT_ANCHOR_TENANT_ID };
        const existing = await repo.findOne({ where });
        if (existing) return { id: existing.id, lastSeq: String(existing.lastSeq ?? '0') };
        const start = await this.initialPosition(subscriptions);
        try {
            await repo.insert({
                ...where,
                lastSeq: start,
                consecutiveFailures: 0,
            } as Partial<PluginEventCursor>);
        } catch {
            // Another replica created it first.
        }
        const row = await repo.findOneOrFail({ where });
        return { id: row.id, lastSeq: String(row.lastSeq ?? '0') };
    }

    private async initialPosition(subscriptions: readonly WebhookSubscription[]): Promise<string> {
        const head = await this.feed.head();
        if (
            subscriptions.length > 0 &&
            subscriptions.every(
                (sub) => sub.startAfterSeq !== null && sub.startAfterSeq !== undefined,
            )
        ) {
            const lowest = subscriptions
                .map((sub) => seqToBigInt(sub.startAfterSeq))
                .reduce((min, seq) => (seq < min ? seq : min));
            return lowest.toString();
        }
        const created = subscriptions
            .map((sub) => (sub.createdAt instanceof Date ? sub.createdAt.getTime() : Number.NaN))
            .filter((time) => Number.isFinite(time));
        if (created.length === 0) return head;
        const first = await this.dataSource
            .getRepository(DomainEvent)
            .createQueryBuilder('event')
            .select('MIN(event.seq)', 'seq')
            .where('event.seq IS NOT NULL')
            .andWhere('event.occurredAt >= :since', { since: new Date(Math.min(...created)) })
            .getRawOne<{ seq: string | number | null }>();
        if (first?.seq === null || first?.seq === undefined) return head;
        const before = seqToBigInt(first.seq) - 1n;
        return (before < 0n ? 0n : before).toString();
    }

    /** Move the cursor forward only (compare-and-set on the value it was read at). */
    private async moveCursor(cursor: { id: string; lastSeq: string }, to: string): Promise<void> {
        if (seqToBigInt(to) <= seqToBigInt(cursor.lastSeq)) return;
        const escape = (name: string) => this.dataSource.driver.escape(name);
        const result = await this.dataSource
            .createQueryBuilder()
            .update(PluginEventCursor)
            .set({ lastSeq: to })
            .where(`${escape('id')} = :id`, { id: cursor.id })
            .andWhere(`${escape('lastSeq')} = :from`, { from: cursor.lastSeq })
            .execute();
        if ((result.affected ?? 0) > 0) cursor.lastSeq = to;
        else {
            // Someone else moved it (another pass): re-read, never move it back.
            const row = await this.dataSource
                .getRepository(PluginEventCursor)
                .findOne({ where: { id: cursor.id } });
            if (row) cursor.lastSeq = String(row.lastSeq ?? cursor.lastSeq);
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
