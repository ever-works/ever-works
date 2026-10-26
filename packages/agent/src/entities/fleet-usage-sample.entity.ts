import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { FleetUsageProvider } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Usage & cost on the fleet (FL-20, CONTRACTS §4.10) — one computer's tokens
 * for one model in one hour, for one provider session and one folder bucket:
 * exactly one row per bucket the node's transcript scan reports.
 *
 * Counts only — never content. A row holds the node's CUMULATIVE totals for
 * its bucket; every report MERGES into it with a field-wise maximum (never a
 * sum), so a re-sent report never double counts and a deleted record file
 * never subtracts (spec FR-4, U4, U5).
 *
 * Attribution (R-13): `fleetSessionId` when the provider session id matches a
 * `FleetSession` on that node; else `agentRunId` when it matches a Task run's
 * `fleetCliSession`; else neither — **other** (a session not started from Ever
 * Works), which a Session created later may still claim (U7).
 *
 * `costCents` is this hour's figure at `priceListVersion`, rounded, for display
 * only; every aggregate re-prices SUMMED tokens per (model, version) and rounds
 * once (lane log decision 6). Null = the model has no list price (tokens only).
 *
 * Epic-local columns beside CONTRACTS §4.10 (lane log, owner question 2):
 * `priceListVersion`, `dedupeKey` (listed in §4.10) and `agentRunId`.
 *
 * Raw uuid references only (no relation), per the EW-654 cycle rule; `nodeId`
 * carries no foreign key, like `fleet_node_health_samples.nodeId`.
 *
 * Migration: `1796200100000-CreateFleetUsageSamples`. Registered in
 * `database/_entities-inventory.ts` and `_entity-names.ts`.
 */
@Entity({ name: 'fleet_usage_samples' })
@Index('uq_fleet_usage_samples_dedupe', ['dedupeKey'], { unique: true })
@Index('idx_fleet_usage_samples_node_bucket', ['nodeId', 'bucketStart'])
@Index('idx_fleet_usage_samples_session', ['fleetSessionId'])
@Index('idx_fleet_usage_samples_run', ['agentRunId'])
@Index('idx_fleet_usage_samples_provider_session', ['nodeId', 'provider', 'providerSessionId'])
export class FleetUsageSample {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    nodeId: string;

    /** The Session the row is attributed to; null = not a Session (a Task run, or other). */
    @Column({ type: 'uuid', nullable: true })
    fleetSessionId?: string | null;

    /** Epic-local: the Task run the row is attributed to when no Session matched (R-13's second key). */
    @Column({ type: 'uuid', nullable: true })
    agentRunId?: string | null;

    /** `claude-code` | `codex`. */
    @Column({ type: 'varchar', length: 32 })
    provider: FleetUsageProvider;

    /** The CLI's own session id; null when the record carried none. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    providerSessionId?: string | null;

    @Column({ type: 'varchar', length: 120 })
    model: string;

    /** Token counts by class — `bigint` (a STRING on Postgres, a number on sqlite; normalised by the repository). */
    @Column({ type: 'bigint', default: 0 })
    inputTokens: string | number;

    @Column({ type: 'bigint', default: 0 })
    outputTokens: string | number;

    @Column({ type: 'bigint', default: 0 })
    cacheReadTokens: string | number;

    @Column({ type: 'bigint', default: 0 })
    cacheWriteTokens: string | number;

    @Column({ type: 'int', default: 0 })
    requests: number;

    /** This hour's list-price cost at `priceListVersion`, rounded; null = tokens only. */
    @Column({ type: 'int', nullable: true })
    costCents?: number | null;

    /** The hour the records fall in, by the RECORD's timestamp (U12). */
    @PortableDateColumn()
    bucketStart: Date;

    /** A known checkout or allowed root on the node; null = "other folders" (or none recorded). */
    @Column({ type: 'text', nullable: true })
    checkoutPath?: string | null;

    /** The `MODEL_LIST_PRICES` version the cost used (FR-7); kept on later merges (U8). Null = tokens only. */
    @Column({ type: 'int', nullable: true })
    priceListVersion?: number | null;

    /**
     * sha256 over node, hour, provider, model, provider session id and the
     * node's folder bucket — unique. A hash because nullable key parts make a
     * plain composite unique index unusable on both SQLite and Postgres.
     */
    @Column({ type: 'varchar', length: 64 })
    dedupeKey: string;

    /** Earliest / latest record time in the bucket. */
    @PortableDateColumn({ nullable: true })
    firstAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    lastAt?: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
