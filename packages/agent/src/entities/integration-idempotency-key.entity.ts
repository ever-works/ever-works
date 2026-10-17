import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { TimestampColumn } from './_types';

export type IntegrationIdempotencyState = 'in_progress' | 'completed';

/**
 * A stored response for `Idempotency-Key` (EW-P1-4, integration contract v1
 * B.1): every create on `/api/integrations/v1` sends one, and a repeat of the
 * same key by the same integration key within 24 h replays the stored
 * response instead of creating twice.
 *
 * `requestHash` is a digest of method + path + body: the same key with a
 * different request is refused (`409 conflict`), never replayed. A row is
 * `in_progress` while the first request runs; a repeat that arrives then is
 * refused too, so two racing retries cannot both create.
 *
 * Holds response bodies of integration DTOs only — never a secret (a webhook
 * secret is returned once and is NOT stored here: those routes opt out).
 */
@Entity({ name: 'integration_idempotency_keys' })
@Index('uq_integration_idempotency_key', ['integrationKeyId', 'idempotencyKey'], { unique: true })
@Index('idx_integration_idempotency_expires', ['expiresAt'])
export class IntegrationIdempotencyKey {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The integration key (`api_keys.id`) the key is scoped to. */
    @Column({ type: 'uuid' })
    integrationKeyId: string;

    @Column({ type: 'varchar', length: 128 })
    idempotencyKey: string;

    /** sha256 hex of `METHOD path\nbody`. */
    @Column({ type: 'varchar', length: 64 })
    requestHash: string;

    @Column({ type: 'varchar', length: 16, default: 'in_progress' })
    state: IntegrationIdempotencyState;

    @Column({ type: 'int', nullable: true })
    responseStatus?: number | null;

    /** The JSON response body, as sent. */
    @Column({ type: 'text', nullable: true })
    responseBody?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    /** When the stored response stops being replayed (24 h after the request). */
    @TimestampColumn()
    expiresAt: Date;
}
