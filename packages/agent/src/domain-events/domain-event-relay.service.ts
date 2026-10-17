import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectDataSource } from '@nestjs/typeorm';
import { domainEventEmitterName, type DomainEventEnvelope } from '@ever-works/contracts';
import { randomBytes } from 'node:crypto';
import { DataSource, type EntityManager, In, IsNull } from 'typeorm';
import { serializeOnSingleConnection } from '../database/repositories/single-connection-write-queue';
import { DomainEvent } from '../entities/domain-event.entity';
import {
    DOMAIN_EVENT_RELAY_STATE_ID,
    DomainEventRelayState,
} from '../entities/domain-event-relay-state.entity';
import { seqToBigInt, toDomainEventEnvelope } from './domain-event-envelope';
import { DomainEventPluginDeliveryService } from './domain-event-plugin-delivery.service';
import { DomainEventRetentionService } from './domain-event-retention.service';
import {
    DOMAIN_EVENTS_NOTIFY_CHANNEL,
    readDomainEventsSettings,
    type DomainEventsSettings,
} from './domain-events.config';

/** Thrown inside the assignment transaction when this replica lost the lease or raced another. */
class RelayFencedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RelayFencedError';
    }
}

/** What one {@link DomainEventRelayService.tick} did. */
export interface DomainEventRelayTickResult {
    readonly leader: boolean;
    /** Events given a feed position (and delivered in process) this tick. */
    readonly dispatched: number;
}

/** A consumer the relay hands every dispatched envelope to, after the in-process emit (e.g. webhooks v2). */
export interface DomainEventConsumer {
    readonly name: string;
    consume(events: readonly DomainEventEnvelope[]): Promise<void>;
}

/** How long `stop()` waits for the tick in flight before releasing the lease anyway. */
const STOP_DRAIN_MS = 15_000;

/** Retention runs at most this often, and only on the leader. */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * The domain event relay (EW-P1-1, `docs/specs/features/domain-events/spec.md` §5).
 *
 * Exactly one API replica relays at a time — the holder of the compare-and-set
 * lease on `domain_event_relay_state`. Each tick the leader:
 *
 *  1. renews its lease (or, when not leader, tries to take a free/expired one);
 *  2. reads up to `batchSize` committed rows with `dispatchedAt IS NULL` in
 *     `outboxSeq` order and, in ONE transaction, gives them the next feed
 *     positions (`seq`) and `dispatchedAt`, then advances `lastSeq` with a
 *     compare-and-set that also re-checks the lease (fencing). A replica that
 *     lost the lease, or raced another, writes nothing;
 *  3. after the commit, emits each envelope as `domain.<type>` on EventEmitter2
 *     (listener errors are logged, never block the relay — in-process delivery
 *     is at most once, like EventEmitter2 today) and hands the batch to the
 *     registered consumers;
 *  4. delivers to `domain-event-subscriber` plugins from their cursors (at
 *     least once) and, at most hourly, runs retention.
 *
 * Positions are assigned only to rows the relay can already see, so a slow
 * transaction that commits after later ones simply gets a later position: the
 * feed is gap-free and never skips a committed event.
 *
 * Wake-up: a 1 s timer, plus Postgres `LISTEN` on the channel the recorder
 * `pg_notify`s inside each writing transaction.
 */
@Injectable()
export class DomainEventRelayService {
    private readonly logger = new Logger(DomainEventRelayService.name);
    readonly holderId = `${process.pid}:${randomBytes(6).toString('hex')}`;

    private settings: DomainEventsSettings = readDomainEventsSettings();
    private timer: NodeJS.Timeout | null = null;
    private running = false;
    private loop: Promise<void> | null = null;
    /** Set by `stop()`: long work in flight (plugin delivery) winds down at its next step. */
    private stopping = false;
    private rerun = false;
    private leader = false;
    private leaseExpiresAt = 0;
    private nextAcquireAttemptAt = 0;
    private lastRetentionAt = 0;
    private listenClient: { release: () => void; query: (sql: string) => Promise<unknown> } | null =
        null;
    private stopped = true;
    private readonly consumers: DomainEventConsumer[] = [];

    constructor(
        @InjectDataSource() private readonly dataSource: DataSource,
        private readonly retention: DomainEventRetentionService,
        @Optional() private readonly events?: EventEmitter2,
        @Optional() private readonly plugins?: DomainEventPluginDeliveryService,
    ) {}

    /** Register a consumer (webhooks v2, …) that receives every dispatched batch. */
    registerConsumer(consumer: DomainEventConsumer): void {
        this.consumers.push(consumer);
    }

    /** Whether this replica currently holds the relay lease. */
    isLeader(): boolean {
        return this.leader;
    }

    /** Start the timer (and, on Postgres, `LISTEN`). No-op when `DOMAIN_EVENTS_RELAY_ENABLED=false`. */
    async start(): Promise<void> {
        this.settings = readDomainEventsSettings();
        if (!this.settings.relayEnabled) {
            this.logger.log(
                'Domain event relay disabled (DOMAIN_EVENTS_RELAY_ENABLED=false); events wait in the outbox',
            );
            return;
        }
        if (!this.stopped) return;
        this.stopped = false;
        this.stopping = false;
        this.timer = setInterval(() => this.wake(), this.settings.relayIntervalMs);
        this.timer.unref?.();
        await this.listen();
        this.wake();
    }

    /**
     * Stop the timer, close the `LISTEN` connection, wait (bounded) for the
     * tick in flight to finish, then release the lease — so a successor never
     * starts while this replica is still delivering.
     */
    async stop(): Promise<void> {
        this.stopping = true;
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.unlisten();
        if (this.loop) {
            await Promise.race([this.loop, delay(STOP_DRAIN_MS)]);
        }
        if (this.leader) {
            try {
                await this.release();
            } catch (error) {
                this.logger.warn(
                    `Could not release the relay lease on shutdown: ${describe(error)}`,
                );
            }
        }
    }

    /** Run a tick now, or right after the one in flight. */
    wake(): void {
        if (this.stopped) return;
        if (this.running) {
            this.rerun = true;
            return;
        }
        this.loop = this.runLoop();
    }

    private async runLoop(): Promise<void> {
        this.running = true;
        try {
            do {
                this.rerun = false;
                const result = await this.tick();
                // A full batch means more is probably waiting: go again at once.
                if (result.dispatched >= this.settings.batchSize) this.rerun = true;
            } while (this.rerun && !this.stopped);
        } catch (error) {
            this.logger.error(`Domain event relay tick failed: ${describe(error)}`);
        } finally {
            this.running = false;
            this.loop = null;
        }
    }

    /**
     * One relay step. Public so tests (and a manual "flush") can drive the
     * relay without the timer.
     */
    async tick(now: Date = new Date()): Promise<DomainEventRelayTickResult> {
        if (!(await this.ensureLeadership(now))) return { leader: false, dispatched: 0 };

        let dispatched: DomainEventEnvelope[] = [];
        try {
            dispatched = await this.assignBatch(now);
        } catch (error) {
            if (error instanceof RelayFencedError) {
                this.logger.warn(`Domain event relay fenced: ${error.message}`);
                this.leader = false;
                return { leader: false, dispatched: 0 };
            }
            throw error;
        }

        if (dispatched.length > 0) await this.deliver(dispatched);

        if (this.plugins) {
            try {
                await this.plugins.deliverPending(undefined, {
                    keepLease: () => this.keepLease(),
                });
            } catch (error) {
                this.logger.warn(`Plugin delivery of domain events failed: ${describe(error)}`);
            }
        }

        if (now.getTime() - this.lastRetentionAt >= RETENTION_INTERVAL_MS) {
            this.lastRetentionAt = now.getTime();
            try {
                await this.retention.purge(now, this.settings.retentionDays);
            } catch (error) {
                this.logger.warn(`Domain event retention failed: ${describe(error)}`);
            }
        }

        return { leader: true, dispatched: dispatched.length };
    }

    // ── lease ──────────────────────────────────────────────────────────────

    /**
     * Renew the lease when due; `false` once this replica no longer leads (or
     * is stopping). Long work (plugin delivery) calls it between steps.
     */
    async keepLease(now: Date = new Date()): Promise<boolean> {
        if (this.stopping || !this.leader) return false;
        return this.ensureLeadership(now);
    }

    private async ensureLeadership(now: Date): Promise<boolean> {
        const ttl = this.settings.leaseTtlMs;
        if (this.leader) {
            // Renew once a third of the lease has elapsed.
            if (this.leaseExpiresAt - now.getTime() > (ttl * 2) / 3) return true;
            if (await this.compareAndSetLease(now, true)) return true;
            this.leader = false;
            this.logger.warn('Domain event relay lost its lease');
            return false;
        }
        if (now.getTime() < this.nextAcquireAttemptAt) return false;
        this.nextAcquireAttemptAt = now.getTime() + Math.min(5_000, ttl / 3);
        await this.ensureStateRow();
        if (await this.compareAndSetLease(now, false)) {
            this.leader = true;
            this.logger.log(`Domain event relay leadership taken by ${this.holderId}`);
            return true;
        }
        return false;
    }

    /** Take (free/expired) or renew (held by me) the lease. */
    private async compareAndSetLease(now: Date, renew: boolean): Promise<boolean> {
        const expiresAt = new Date(now.getTime() + this.settings.leaseTtlMs);
        const query = this.dataSource
            .createQueryBuilder()
            .update(DomainEventRelayState)
            .set({ holder: this.holderId, leaseExpiresAt: expiresAt })
            .where(`${this.column('id')} = :id`, { id: DOMAIN_EVENT_RELAY_STATE_ID });
        if (renew) {
            query.andWhere(`${this.column('holder')} = :holder`, { holder: this.holderId });
        } else {
            query.andWhere(
                `(${this.column('holder')} IS NULL OR ${this.column('leaseExpiresAt')} IS NULL OR ${this.column(
                    'leaseExpiresAt',
                )} < :now OR ${this.column('holder')} = :holder)`,
                { now, holder: this.holderId },
            );
        }
        const result = await query.execute();
        const won = (result.affected ?? 0) === 1;
        if (won) this.leaseExpiresAt = expiresAt.getTime();
        return won;
    }

    private async release(): Promise<void> {
        await this.dataSource
            .createQueryBuilder()
            .update(DomainEventRelayState)
            .set({ holder: null, leaseExpiresAt: null })
            .where(`${this.column('id')} = :id`, { id: DOMAIN_EVENT_RELAY_STATE_ID })
            .andWhere(`${this.column('holder')} = :holder`, { holder: this.holderId })
            .execute();
        this.leader = false;
    }

    /** The one state row (the migration seeds it; this covers a synchronize-built schema). */
    private async ensureStateRow(): Promise<void> {
        await this.dataSource
            .createQueryBuilder()
            .insert()
            .into(DomainEventRelayState)
            .values({ id: DOMAIN_EVENT_RELAY_STATE_ID, lastSeq: 0, retentionFloorSeq: 0 })
            .orIgnore()
            .execute();
    }

    // ── positions ──────────────────────────────────────────────────────────

    private async assignBatch(now: Date): Promise<DomainEventEnvelope[]> {
        const pending = await this.dataSource.getRepository(DomainEvent).find({
            where: { dispatchedAt: IsNull() },
            order: { outboxSeq: 'ASC' },
            take: this.settings.batchSize,
            select: { outboxSeq: true },
        });
        if (pending.length === 0) return [];

        const outboxSeqs = pending.map((row) => row.outboxSeq);
        // better-sqlite3 runs a whole DataSource on ONE connection, where
        // overlapping transactions nest as savepoints of each other: queue this
        // one behind the platform's other serialized writes (see
        // single-connection-write-queue.ts). Pooled drivers run it at once.
        await serializeOnSingleConnection(this.dataSource.manager, () =>
            this.dataSource.transaction(async (manager) => {
                await this.assignPositions(manager, outboxSeqs, now);
            }),
        );

        const rows = await this.dataSource.getRepository(DomainEvent).find({
            where: { outboxSeq: In(outboxSeqs) },
        });
        return rows
            .sort((a, b) => (seqToBigInt(a.seq) < seqToBigInt(b.seq) ? -1 : 1))
            .map((row) => toDomainEventEnvelope(row));
    }

    /** Give `outboxSeqs` the next positions and advance `lastSeq`, fenced by the lease. */
    private async assignPositions(
        manager: EntityManager,
        outboxSeqs: ReadonlyArray<number | string>,
        now: Date,
    ): Promise<void> {
        const state = await manager
            .getRepository(DomainEventRelayState)
            .findOne({ where: { id: DOMAIN_EVENT_RELAY_STATE_ID } });
        if (!state) throw new RelayFencedError('relay state row missing');
        const stored = seqToBigInt(state.lastSeq);
        // Self-heal: never hand out a position at or below one already
        // assigned (a restored backup or a hand edit could leave lastSeq
        // behind), which would otherwise wedge the relay on the unique index.
        const maxAssigned = (await manager
            .getRepository(DomainEvent)
            .createQueryBuilder('event')
            .select('MAX(event.seq)', 'max')
            .getRawOne()) as { max?: string | number | null } | undefined;
        const assigned = seqToBigInt(maxAssigned?.max ?? 0);
        const previous = assigned > stored ? assigned : stored;
        let next = previous;
        for (const outboxSeq of outboxSeqs) {
            next += 1n;
            const updated = await manager
                .createQueryBuilder()
                .update(DomainEvent)
                .set({ seq: next.toString(), dispatchedAt: now })
                .where(`${this.column('outboxSeq')} = :outboxSeq`, { outboxSeq })
                .andWhere(`${this.column('dispatchedAt')} IS NULL`)
                .execute();
            if ((updated.affected ?? 0) !== 1) {
                throw new RelayFencedError(`row ${outboxSeq} was dispatched concurrently`);
            }
        }
        const fenced = await manager
            .createQueryBuilder()
            .update(DomainEventRelayState)
            .set({ lastSeq: next.toString() })
            .where(`${this.column('id')} = :id`, { id: DOMAIN_EVENT_RELAY_STATE_ID })
            .andWhere(`${this.column('holder')} = :holder`, { holder: this.holderId })
            .andWhere(`${this.column('leaseExpiresAt')} > :now`, { now })
            .andWhere(`${this.column('lastSeq')} = :stored`, {
                stored: stored.toString(),
            })
            .execute();
        if ((fenced.affected ?? 0) !== 1) {
            throw new RelayFencedError('lease lost or lastSeq moved during assignment');
        }
    }

    // ── delivery ───────────────────────────────────────────────────────────

    private async deliver(envelopes: readonly DomainEventEnvelope[]): Promise<void> {
        if (this.events) {
            for (const envelope of envelopes) {
                try {
                    await withTimeout(
                        this.events.emitAsync(domainEventEmitterName(envelope.type), envelope),
                        this.settings.listenerTimeoutMs,
                        `listeners of ${domainEventEmitterName(envelope.type)}`,
                    );
                } catch (error) {
                    this.logger.warn(
                        `A listener of ${domainEventEmitterName(envelope.type)} failed for ${envelope.id}: ${describe(error)}`,
                    );
                }
            }
        }
        for (const consumer of this.consumers) {
            try {
                await withTimeout(
                    consumer.consume(envelopes),
                    this.settings.listenerTimeoutMs,
                    `consumer ${consumer.name}`,
                );
            } catch (error) {
                this.logger.warn(
                    `Domain event consumer ${consumer.name} failed: ${describe(error)}`,
                );
            }
        }
    }

    // ── Postgres LISTEN ────────────────────────────────────────────────────

    private async listen(): Promise<void> {
        if (this.dataSource.options.type !== 'postgres') return;
        try {
            // The pg Pool behind TypeORM's Postgres driver (see auth-runtime.instance.ts).
            const pool = (
                this.dataSource.driver as unknown as {
                    master?: { connect: () => Promise<unknown> };
                }
            ).master;
            if (!pool) return;
            const client = (await pool.connect()) as {
                release: (error?: unknown) => void;
                query: (sql: string) => Promise<unknown>;
                on: (event: string, listener: (...args: unknown[]) => void) => void;
            };
            client.on('notification', () => this.wake());
            client.on('error', (error: unknown) => {
                this.logger.warn(
                    `Domain event LISTEN connection failed; polling continues: ${describe(error)}`,
                );
                this.unlisten(error);
            });
            await client.query(`LISTEN ${DOMAIN_EVENTS_NOTIFY_CHANNEL}`);
            this.listenClient = client;
        } catch (error) {
            this.logger.warn(
                `Could not LISTEN for domain events; polling only: ${describe(error)}`,
            );
        }
    }

    private unlisten(error?: unknown): void {
        const client = this.listenClient as { release: (error?: unknown) => void } | null;
        this.listenClient = null;
        if (!client) return;
        try {
            // Releasing with an error destroys the connection instead of returning it LISTENing to the pool.
            client.release(error ?? new Error('domain event relay stopped listening'));
        } catch {
            // already gone
        }
    }

    private column(name: string): string {
        return this.dataSource.driver.escape(name);
    }
}

/** Resolve with `promise`, or reject after `ms` (the promise keeps running; its result is ignored). */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
        timer.unref?.();
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
