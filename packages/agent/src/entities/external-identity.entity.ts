import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
    Unique,
    UpdateDateColumn,
} from 'typeorm';
import { PortableDateColumn } from './_types';
import { User } from './user.entity';

/** How a connected identity came to exist (APW-12 plan §3.1, FR-31). */
export type ExternalIdentityLinkedVia = 'sign-up' | 'settings' | 'provisioning';

/** One app that read the person's App Works with a delegated permission (FR-31, FR-48). */
export interface ExternalIdentityDelegatedClient {
    clientId: string;
    /** ISO-8601 timestamp of the client's most recent delegated read. */
    lastSeenAt: string;
}

/**
 * APW-12 (Ever ID) — a connected identity: the pair (issuer, subject) of an
 * OpenID Connect provider, bound to exactly one Ever Works account (spec FR-21,
 * plan §3.1).
 *
 * The pair — never the e-mail address — selects an account (FR-22). The two
 * unique constraints are the whole account-linking rule set in the database:
 *
 * - `uq_external_identities_issuer_subject` — one account per pair. It decides
 *   the S24 race (a sign-up and a connect of the same identity at once): exactly
 *   one insert wins and the other is answered `subjectLinked`.
 * - `uq_external_identities_user_issuer` — at most one pair per account per
 *   issuer (`userHasIssuer`).
 *
 * What is stored is FR-31's list and nothing else: no access, ID or refresh
 * token is ever written here (FR-31, FR-38, ACC-12-22). `emailAtLink` is
 * display-only — it is never used to resolve an account.
 *
 * Deleting the account deletes its connected identities (`onDelete: CASCADE`,
 * FR-30, ACC-12-41); removing a connected identity never deletes an account.
 * `tenantId` is the Tier B scope stamp; there is deliberately no
 * `organizationId`, because an identity belongs to a person, not to whichever
 * Organization happened to be active when it was connected.
 */
@Entity({ name: 'external_identities' })
@Unique('uq_external_identities_issuer_subject', ['issuer', 'subject'])
@Unique('uq_external_identities_user_issuer', ['userId', 'issuer'])
@Index('idx_external_identities_user', ['userId'])
export class ExternalIdentity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'userId' })
    user?: User;

    /** The exact `iss` string of the provider (FR-11, FR-21). */
    @Column({ type: 'varchar', length: 512 })
    issuer: string;

    /** The exact `sub` claim, 1–255 characters (FR-11). */
    @Column({ type: 'varchar', length: 255 })
    subject: string;

    /** The provider's e-mail at the time of connection — display only (FR-31). */
    @Column({ type: 'varchar', length: 320 })
    emailAtLink: string;

    /** Whether that e-mail was verified at the provider at connection time (FR-31). */
    @Column({ type: 'boolean' })
    emailVerifiedAtLink: boolean;

    /** `sign-up` | `settings` | `provisioning` — how the connection was made (FR-31). */
    @Column({ type: 'varchar', length: 16 })
    linkedVia: ExternalIdentityLinkedVia;

    @PortableDateColumn()
    linkedAt: Date;

    /** Updated by every sign-in through this identity; never by a delegated read (FR-47). */
    @PortableDateColumn({ nullable: true })
    lastLoginAt?: Date | null;

    /** At most 10 apps that used a delegated read, oldest evicted (FR-31, FR-48). */
    @Column({ type: 'simple-json', nullable: true })
    delegatedClients?: ExternalIdentityDelegatedClient[] | null;

    /** Tier B scope stamp: the owning user's Tenant, when they have one. */
    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
