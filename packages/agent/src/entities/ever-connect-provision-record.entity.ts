import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';

/**
 * Where a creation stands: `pending` while an attempt holds it, `created`, or
 * `partial` (the company exists, staffing or the first Mission did not work);
 * `failed` (a later attempt finishes it) or `refused` (the person declined).
 */
export type EverConnectProvisionStatus = 'pending' | 'created' | 'partial' | 'refused' | 'failed';

/** Where the report to Ever Platform stands. */
export type EverConnectProvisionCallbackStatus = 'pending' | 'sent' | 'failed';

/** One optional step's outcome. */
export interface EverConnectProvisionStepResult {
    status: 'running' | 'created' | 'skipped' | 'failed';
    code?: string;
}

/** What the import reported, for the answer. */
export interface EverConnectProvisionStaffing extends EverConnectProvisionStepResult {
    templateSlug?: string;
    agents?: number;
    teams?: number;
    skills?: number;
    works?: number;
    tasks?: number;
}

/** The steps done so far, so a stopped creation is finished by the next attempt. */
export interface EverConnectProvisionSteps {
    cursor: 'none' | 'core_done' | 'registered' | 'done';
    staffing?: EverConnectProvisionStaffing;
    mission?: EverConnectProvisionStepResult;
}

/**
 * One company creation from Ever Platform, by the key of its step
 * (`creationKey`, the signed `idempotency_key`): the same key never creates a
 * second company. Identifiers and machine codes only; pruned after 30 days.
 *
 * - `intentJti`: the request this creation answers now. A retry of the step
 *   comes as a new request and takes the creation over, so the report names it.
 * - `idempotencyKey`, `bodyHash`: the browser's own retry of one confirmation.
 * - `claimedBy`, `claimedUntil`: the attempt running it; renewed after each step,
 *   so only one that stopped loses it.
 * - `everOrgKey`: the Ever organization while this creation holds it (unique):
 *   one Ever organization never gets two companies.
 * - `callback*`, `completedAt`, `platformLinkId`: the report that the company
 *   exists (or that the person declined), with its retries.
 */
@Entity({ name: 'ever_connect_provision_records' })
@Index('uq_ever_connect_provision_records_key', ['creationKey'], { unique: true })
@Index('uq_ever_connect_provision_records_jti', ['intentJti'], { unique: true })
@Index('uq_ever_connect_provision_records_org', ['everOrgKey'], { unique: true })
@Index('idx_ever_connect_provision_records_callback', ['callbackStatus', 'nextCallbackAt'])
export class EverConnectProvisionRecord {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 200 })
    creationKey: string;

    @Column({ type: 'varchar', length: 64 })
    intentJti: string;

    /** The `iat` of that request: an older request never takes a creation back. */
    @Column({ type: 'int', default: 0 })
    intentIssuedAt: number;

    @Column({ type: 'varchar', length: 128, nullable: true })
    idempotencyKey: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    bodyHash: string | null;

    @Column({ type: 'varchar', length: 64 })
    everOrgId: string;

    @Column({ type: 'varchar', length: 64, nullable: true })
    everOrgKey: string | null;

    @Column({ type: 'varchar', length: 64 })
    handle: string;

    @Column({ type: 'uuid', nullable: true })
    userId: string | null;

    @Column({ type: 'uuid', nullable: true })
    tenantId: string | null;

    @Column({ type: 'uuid', nullable: true })
    organizationId: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    organizationSlug: string | null;

    @Column({ type: 'uuid', nullable: true })
    companyWorkId: string | null;

    @Column({ type: 'uuid', nullable: true })
    missionId: string | null;

    @Column({ type: 'simple-json' })
    steps: EverConnectProvisionSteps;

    @Column({ type: 'varchar', length: 16, default: 'pending' })
    status: EverConnectProvisionStatus;

    @Column({ type: 'varchar', length: 64, nullable: true })
    errorCode: string | null;

    @Column({ type: 'varchar', length: 36, nullable: true })
    claimedBy: string | null;

    @PortableDateColumn({ nullable: true })
    claimedUntil: Date | null;

    @Column({ type: 'varchar', length: 16, nullable: true })
    callbackStatus: EverConnectProvisionCallbackStatus | null;

    @Column({ type: 'int', default: 0 })
    callbackAttempts: number;

    @PortableDateColumn({ nullable: true })
    nextCallbackAt: Date | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    callbackError: string | null;

    /** When Ever Platform answered the report; it is not asked again after that. */
    @PortableDateColumn({ nullable: true })
    completedAt: Date | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    platformLinkId: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
