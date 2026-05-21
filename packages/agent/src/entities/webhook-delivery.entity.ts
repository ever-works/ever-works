import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
} from 'typeorm';
import { TimestampColumn } from './_types';

/**
 * Per-attempt log of an outbound webhook delivery.
 *
 *  - `pending`   — created by the dispatcher, not yet attempted
 *  - `delivered` — the most recent attempt returned 2xx
 *  - `failed`    — terminal failure; either a 4xx, an SSRF/redirect refusal,
 *                  a payload-too-large error, or the retry budget ran out
 *  - `retrying`  — attempted at least once with a retryable outcome;
 *                  Trigger.dev has been told to retry on backoff
 *
 * The row carries the event name and the raw payload so the operator-facing
 * `POST /api/webhooks/deliveries/:id/redeliver` endpoint can re-enqueue
 * the same delivery without needing the original producer.
 */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'retrying';

@Entity({ name: 'webhook_deliveries' })
@Index(['subscriptionId', 'createdAt'])
@Index(['accountId', 'createdAt'])
@Index(['status'])
export class WebhookDelivery {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    subscriptionId: string;

    /**
     * Denormalized from the subscription at enqueue time so the deliveries
     * list endpoint can scope by caller in a single index without a join.
     */
    @Column({ type: 'uuid' })
    accountId: string;

    @Column({ type: 'varchar', length: 128 })
    event: string;

    /**
     * Raw JSON payload as it was signed. Re-enqueueing a delivery uses
     * THIS payload — not the freshly-emitted producer-side event — so the
     * receiver sees the same body it would have seen the first time.
     *
     * x-secret-adjacent: payloads may carry user-scoped business data; the
     * deliveries list endpoint redacts the body before returning it.
     *
     * Column type is `simple-json` (portable across Postgres + SQLite)
     * rather than `jsonb` (Postgres-only). The migration creates the
     * physical column as `jsonb` on Postgres production; TypeORM's
     * `simple-json` driver reads/writes JSON via JSON.stringify/parse
     * which works equally well against a `jsonb` (prod) or `text`
     * (test/SQLite synchronize) column. Using `jsonb` here would break
     * the better-sqlite3 test path with
     * `DataTypeNotSupportedError: Data type "jsonb" ... is not supported
     * by "better-sqlite3" database.` (caught on CI for PR #888).
     */
    @Column({ type: 'simple-json' })
    payload: Record<string, unknown>;

    @Column({ type: 'varchar', length: 32, default: 'pending' })
    status: WebhookDeliveryStatus;

    @Column({ type: 'int', default: 0 })
    attempts: number;

    @Column({ type: 'int', nullable: true })
    lastResponseStatus: number | null;

    /**
     * Discriminated outcome of the last attempt. Mirrors the `DeliveryOutcome`
     * union from `WebhookDeliveryService` — kept as a free-form string so a
     * future outcome bucket doesn't require a schema migration.
     */
    @Column({ type: 'varchar', length: 32, nullable: true })
    lastOutcome: string | null;

    @Column({ type: 'text', nullable: true })
    lastError: string | null;

    @Column({ type: 'int', nullable: true })
    durationMs: number | null;

    /** Trigger.dev run id of the most recent attempt; null in in-process mode. */
    @Column({ type: 'varchar', length: 128, nullable: true })
    triggerRunId: string | null;

    @TimestampColumn({ nullable: true })
    lastAttemptAt: Date | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
