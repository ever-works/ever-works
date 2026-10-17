import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { matchesAnyDomainEventPattern } from '@ever-works/contracts';
import {
    DOMAIN_EVENT_SUBSCRIBER_CAPABILITY,
    isDomainEventSubscriberPlugin,
    type IDomainEventSubscriberPlugin,
} from '@ever-works/plugin';
import { DataSource, MoreThan } from 'typeorm';
import { DomainEvent } from '../entities/domain-event.entity';
import {
    DOMAIN_EVENT_RELAY_STATE_ID,
    DomainEventRelayState,
} from '../entities/domain-event-relay-state.entity';
import { PluginEventCursor } from '../entities/plugin-event-cursor.entity';
import { Tenant } from '../entities/tenant.entity';
import { materializePlugin } from '../plugins/services/plugin-operation.util';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { seqToBigInt, toDomainEventEnvelope } from './domain-event-envelope';
import { DOMAIN_EVENT_PLUGIN_MAX_FAILURES, readDomainEventsSettings } from './domain-events.config';

/**
 * The cursor row a plugin gets on first sight: where tenants with no cursor of
 * their own start (the head at the time the plugin was first seen), so a newly
 * installed plugin receives new events, not the whole retained history.
 */
export const PLUGIN_EVENT_ANCHOR_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Events read per plugin per pass. */
const PLUGIN_BATCH = 200;

/** Options of a delivery pass. */
export interface DeliveryOptions {
    /** Renew the relay lease when due; `false` once this replica no longer leads (stops the pass). */
    readonly keepLease?: () => Promise<boolean>;
}

/** A cursor being worked on, with the `lastSeq` it was read at (`null` = not stored yet). */
interface TrackedCursor {
    readonly row: PluginEventCursor;
    readonly readSeq: bigint | null;
    touched?: boolean;
}

/** A loaded, enabled-somewhere subscriber, ready to call. */
export interface ResolvedDomainEventSubscriber {
    readonly pluginId: string;
    readonly plugin: IDomainEventSubscriberPlugin;
}

/**
 * Delivers dispatched domain events to `domain-event-subscriber` plugins
 * (EW-P1-1, spec §6) — at least once, per plugin and tenant, in `seq` order.
 *
 * - A tenant receives events only while the plugin is enabled for it (enabled
 *   for the tenant's owner, or system/auto-enabled).
 * - The cursor (`plugin_event_cursors.lastSeq`) moves only after
 *   `onDomainEvent` resolves within the timeout; a failure stops that tenant's
 *   delivery for this pass (later events wait, order is kept) and is retried on
 *   the next pass.
 * - After {@link DOMAIN_EVENT_PLUGIN_MAX_FAILURES} consecutive failures on one
 *   event, the event is dead-lettered: logged, counted, and passed.
 *
 * Called by the relay on every tick while it is the leader.
 */
@Injectable()
export class DomainEventPluginDeliveryService {
    private readonly logger = new Logger(DomainEventPluginDeliveryService.name);

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        @Optional() private readonly registry?: PluginRegistryService,
    ) {}

    /** The loaded plugins that declare the capability and implement the contract. */
    async subscribers(): Promise<ResolvedDomainEventSubscriber[]> {
        if (!this.registry) return [];
        const resolved: ResolvedDomainEventSubscriber[] = [];
        for (const entry of this.registry.getByCapability(DOMAIN_EVENT_SUBSCRIBER_CAPABILITY)) {
            if (entry.state === 'error') continue;
            try {
                const instance = (await materializePlugin(entry.plugin)) ?? entry.plugin;
                if (isDomainEventSubscriberPlugin(instance)) {
                    resolved.push({ pluginId: entry.plugin.id, plugin: instance });
                }
            } catch (error) {
                this.logger.warn(
                    `Could not load domain event subscriber ${entry.plugin.id}: ${describe(error)}`,
                );
            }
        }
        return resolved;
    }

    /**
     * One delivery pass for every subscriber.
     *
     * `keepLease` is called before each plugin call: it renews the relay lease
     * when due and answers `false` once this replica no longer leads, which
     * stops the pass (progress so far is kept). Cursor writes are
     * compare-and-set, so a replica that lost the lease mid-pass can never
     * overwrite the progress its successor made.
     */
    async deliverPending(
        subscribers?: readonly ResolvedDomainEventSubscriber[],
        options: DeliveryOptions = {},
    ): Promise<void> {
        const list = subscribers ?? (await this.subscribers());
        for (const subscriber of list) {
            if (options.keepLease && !(await options.keepLease())) return;
            try {
                await this.deliverFor(subscriber, options);
            } catch (error) {
                this.logger.warn(
                    `Domain event delivery to ${subscriber.pluginId} failed: ${describe(error)}`,
                );
            }
        }
    }

    /** One pass for one plugin. Public for tests. */
    async deliverFor(
        subscriber: ResolvedDomainEventSubscriber,
        options: DeliveryOptions = {},
    ): Promise<void> {
        const { pluginId, plugin } = subscriber;
        const cursorRepo = this.dataSource.getRepository(PluginEventCursor);
        const cursors = await cursorRepo.find({ where: { pluginId } });

        const anchor = cursors.find((cursor) => cursor.tenantId === PLUGIN_EVENT_ANCHOR_TENANT_ID);
        if (!anchor) {
            const state = await this.dataSource
                .getRepository(DomainEventRelayState)
                .findOne({ where: { id: DOMAIN_EVENT_RELAY_STATE_ID } });
            await this.insertCursor(
                pluginId,
                PLUGIN_EVENT_ANCHOR_TENANT_ID,
                seqToBigInt(state?.lastSeq),
            );
            return;
        }

        /** Tenant cursors, with the `lastSeq` each was READ at (the compare-and-set base). */
        const byTenant = new Map<string, TrackedCursor>(
            cursors
                .filter((cursor) => cursor.tenantId !== PLUGIN_EVENT_ANCHOR_TENANT_ID)
                .map((cursor) => [
                    cursor.tenantId,
                    { row: cursor, readSeq: seqToBigInt(cursor.lastSeq) },
                ]),
        );
        const anchorSeq = seqToBigInt(anchor.lastSeq);
        let from = anchorSeq;
        for (const { readSeq } of byTenant.values()) {
            if (readSeq !== null && readSeq < from) from = readSeq;
        }

        const events = await this.dataSource.getRepository(DomainEvent).find({
            where: { seq: MoreThan(from.toString() as unknown as number) },
            order: { seq: 'ASC' },
            take: PLUGIN_BATCH,
        });
        if (events.length === 0) return;

        const timeoutMs = readDomainEventsSettings().pluginTimeoutMs;
        const blocked = new Set<string>();
        const enabledCache = new Map<string, boolean>();
        /** The highest position this pass examined (every tenant's rows up to it were looked at). */
        let examined = from;
        let leaseLost = false;

        for (const row of events) {
            const seq = seqToBigInt(row.seq);
            const tenantId = row.tenantId;
            if (tenantId && !blocked.has(tenantId)) {
                let tracked = byTenant.get(tenantId);
                if (!tracked) {
                    tracked = {
                        row: cursorRepo.create({
                            pluginId,
                            tenantId,
                            lastSeq: anchorSeq.toString(),
                            consecutiveFailures: 0,
                            deadLetterCount: 0,
                        }),
                        readSeq: null,
                    };
                    byTenant.set(tenantId, tracked);
                }
                const cursor = tracked.row;
                if (seq > seqToBigInt(cursor.lastSeq)) {
                    const wanted = matchesAnyDomainEventPattern(row.type, plugin.subscribes);
                    if (
                        !wanted ||
                        !(await this.isEnabledForTenant(pluginId, tenantId, enabledCache))
                    ) {
                        cursor.lastSeq = seq.toString();
                    } else {
                        if (options.keepLease && !(await options.keepLease())) {
                            leaseLost = true;
                            break;
                        }
                        const attempt = (cursor.consecutiveFailures ?? 0) + 1;
                        try {
                            await callWithTimeout(
                                (signal) =>
                                    plugin.onDomainEvent(toDomainEventEnvelope(row), {
                                        tenantId,
                                        attempt,
                                        signal,
                                    }),
                                timeoutMs,
                            );
                            cursor.lastSeq = seq.toString();
                            cursor.consecutiveFailures = 0;
                        } catch (error) {
                            cursor.consecutiveFailures = attempt;
                            cursor.lastError = describe(error).slice(0, 2000);
                            cursor.lastErrorAt = new Date();
                            if (attempt >= DOMAIN_EVENT_PLUGIN_MAX_FAILURES) {
                                this.logger.error(
                                    `Dead-lettering ${row.id} (${row.type}) for plugin ${pluginId} after ${attempt} failures: ${cursor.lastError}`,
                                );
                                cursor.lastSeq = seq.toString();
                                cursor.consecutiveFailures = 0;
                                cursor.deadLetterCount = (cursor.deadLetterCount ?? 0) + 1;
                                cursor.lastDeadLetterEventId = row.id;
                            } else {
                                blocked.add(tenantId);
                            }
                        }
                        tracked.touched = true;
                    }
                }
            }
            examined = seq;
        }

        // A tenant with nothing pending up to `examined` (quiet, or fully caught
        // up) moves to `examined`, so one quiet tenant never pins the scan start
        // for the whole plugin. Only tenants that failed in this pass stay put.
        for (const [tenantId, tracked] of byTenant) {
            if (blocked.has(tenantId)) continue;
            if (seqToBigInt(tracked.row.lastSeq) < examined) {
                tracked.row.lastSeq = examined.toString();
            }
        }

        for (const tracked of byTenant.values()) {
            const changed =
                tracked.readSeq === null ||
                tracked.touched === true ||
                seqToBigInt(tracked.row.lastSeq) !== tracked.readSeq;
            if (!changed) continue;
            if (tracked.readSeq === null) {
                await this.insertCursor(
                    pluginId,
                    tracked.row.tenantId,
                    seqToBigInt(tracked.row.lastSeq),
                    tracked.row,
                );
            } else {
                await this.compareAndSetCursor(tracked.row, tracked.readSeq);
            }
        }
        // Tenants with no cursor of their own start from the anchor: move it past
        // everything this pass examined (every tenant seen now has its own row).
        if (examined > anchorSeq) {
            await this.compareAndSetCursor({ ...anchor, lastSeq: examined.toString() }, anchorSeq);
        }
        if (leaseLost) {
            this.logger.warn(
                `Stopped delivering to ${pluginId}: this replica no longer holds the relay lease`,
            );
        }
    }

    private async insertCursor(
        pluginId: string,
        tenantId: string,
        lastSeq: bigint,
        state?: Partial<PluginEventCursor>,
    ): Promise<void> {
        await this.dataSource
            .createQueryBuilder()
            .insert()
            .into(PluginEventCursor)
            .values({
                pluginId,
                tenantId,
                lastSeq: lastSeq.toString(),
                consecutiveFailures: state?.consecutiveFailures ?? 0,
                lastError: state?.lastError ?? null,
                lastErrorAt: state?.lastErrorAt ?? null,
                deadLetterCount: state?.deadLetterCount ?? 0,
                lastDeadLetterEventId: state?.lastDeadLetterEventId ?? null,
            })
            .orIgnore()
            .execute();
    }

    /** Write a cursor only if its `lastSeq` is still what this pass read (else another replica moved it). */
    private async compareAndSetCursor(cursor: PluginEventCursor, readSeq: bigint): Promise<void> {
        const escape = (name: string) => this.dataSource.driver.escape(name);
        const result = await this.dataSource
            .createQueryBuilder()
            .update(PluginEventCursor)
            .set({
                lastSeq: seqToBigInt(cursor.lastSeq).toString(),
                consecutiveFailures: cursor.consecutiveFailures ?? 0,
                lastError: cursor.lastError ?? null,
                lastErrorAt: cursor.lastErrorAt ?? null,
                deadLetterCount: cursor.deadLetterCount ?? 0,
                lastDeadLetterEventId: cursor.lastDeadLetterEventId ?? null,
            })
            .where(`${escape('id')} = :id`, { id: cursor.id })
            .andWhere(`${escape('lastSeq')} = :readSeq`, { readSeq: readSeq.toString() })
            .execute();
        if ((result.affected ?? 0) === 0) {
            this.logger.warn(
                `Plugin cursor ${cursor.pluginId}/${cursor.tenantId} moved concurrently; keeping the other replica's progress`,
            );
        }
    }

    private async isEnabledForTenant(
        pluginId: string,
        tenantId: string,
        cache: Map<string, boolean>,
    ): Promise<boolean> {
        const cached = cache.get(tenantId);
        if (cached !== undefined) return cached;
        let enabled = false;
        if (this.registry) {
            const tenant = await this.dataSource
                .getRepository(Tenant)
                .findOne({ where: { id: tenantId } });
            enabled = await this.registry.isPluginEnabledForScope(
                pluginId,
                undefined,
                tenant?.ownerUserId,
            );
        }
        cache.set(tenantId, enabled);
        return enabled;
    }
}

/** Run `fn` with an abort signal that fires after `timeoutMs`; reject on timeout. */
async function callWithTimeout(
    fn: (signal: AbortSignal) => Promise<void>,
    timeoutMs: number,
): Promise<void> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        timer.unref?.();
    });
    try {
        await Promise.race([fn(controller.signal), timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
