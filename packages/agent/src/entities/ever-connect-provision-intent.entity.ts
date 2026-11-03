import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { PortableDateColumn } from './_types';

/** Where a received request stands. */
export type EverConnectProvisionIntentStatus = 'pending' | 'accepted' | 'refused';

/**
 * One signed request from Ever Platform to create a company (its `jti`), kept
 * while the person signs in with Ever ID and confirms. Ever Platform makes a new
 * request for each attempt of a step, all under the step's key
 * (`idempotencyKey`), so several rows may lead to one creation
 * ({@link EverConnectProvisionRecord}).
 *
 * `claims` is what was verified, as JSON: ids and public names, the person's Ever
 * ID subject and, until the company exists, the first Mission the person wrote.
 * The signed document itself is never stored. A row is removed a day after the
 * request ended.
 */
@Entity({ name: 'ever_connect_provision_intents' })
@Index('idx_ever_connect_provision_intents_key', ['idempotencyKey'])
@Index('idx_ever_connect_provision_intents_expires', ['expiresAt'])
export class EverConnectProvisionIntent {
    @PrimaryColumn({ type: 'varchar', length: 64 })
    jti: string;

    /** The key of the step this request is an attempt of. */
    @Column({ type: 'varchar', length: 200 })
    idempotencyKey: string;

    @Column({ type: 'text' })
    claims: string;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: EverConnectProvisionIntentStatus;

    @PortableDateColumn()
    expiresAt: Date;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
