import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';
import type { SharedViewSectionsDto, SharedViewStatus } from '@ever-works/contracts/api';
import { EncryptedJsonColumn } from './_secret-json-column';
import { PortableDateColumn } from './_types';

/** The envelope the re-copyable share token is stored in. Every value is encrypted at rest. */
export interface SharedViewTokenEnvelope {
    token: string;
}

/**
 * The values a freshly turned-on Shared view starts with: the board on,
 * knowledge off, no class selected, crawlers blocked, and the link live.
 * One function so the repository and the specs cannot disagree.
 */
export function sharedViewDefaults(): {
    status: SharedViewStatus;
    sections: SharedViewSectionsDto;
    knowledgeClasses: string[];
    searchIndexable: boolean;
    viewCount: number;
    rotationCount: number;
} {
    return {
        status: 'active',
        sections: { board: true, knowledge: false },
        knowledgeClasses: [],
        searchIndexable: false,
        viewCount: 0,
        rotationCount: 0,
    };
}

/**
 * Shared view — one Workspace's read-only published face.
 *
 * A small, long-lived configuration row, not a document and not a snapshot:
 * it holds WHAT may be read (sections, knowledge classes, crawler posture)
 * and BY WHICH token. The published content is always computed live from the
 * Workspace's own Task board, so there is never a second copy of task data.
 *
 * ## The token
 *
 * The share token follows the Organization invitation's pattern — 256 bits,
 * looked up only by `sha256(token)` through a unique index — with one
 * deliberate divergence: a share link must be re-copyable for months, so the
 * token is ALSO kept envelope-encrypted (`tokenEncrypted`, the same AES-256-GCM
 * column helper `notification_channels.targetConfig` uses) and decrypted only
 * for the Tenant owner's own settings read. The public path never decrypts.
 *
 * ## Revocation without a session table
 *
 * `rotationCount` increments on every regenerate. A view session carries the
 * count it was minted under, so every outstanding session dies on its next
 * request the moment the link is regenerated; `status = 'paused'` and deleting
 * the row kill them the same way.
 *
 * One row per Organization (unique `organizationId`, FK ON DELETE CASCADE in
 * migration `1791180000000-CreateSharedViews`), so deleting the Workspace
 * deletes its link in the same transaction. Scope columns are raw uuids (no
 * `@ManyToOne`) per the entity-cycle rule. Also registered in
 * `database/_entities-inventory.ts` and `database/_entity-names.ts`.
 */
@Entity({ name: 'shared_views' })
@Index('uq_shared_views_organization', ['organizationId'], { unique: true })
@Index('uq_shared_views_token_hash', ['tokenHash'], { unique: true })
@Index('idx_shared_views_tenant', ['tenantId'])
export class SharedView {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The Workspace this view publishes. One view per Workspace. */
    @Column({ type: 'uuid' })
    organizationId: string;

    /** Copied from the Organization when the view is created. */
    @Column({ type: 'uuid' })
    tenantId: string;

    /**
     * The Tenant owner when the view was created. Denormalised so the public
     * read resolves the owner's board without a join to `tenants`; every owner
     * check still resolves the live Tenant owner.
     */
    @Column({ type: 'uuid' })
    ownerUserId: string;

    /** `sha256(token)` as lowercase hex — the only thing the public path looks up. */
    @Column({ type: 'varchar', length: 64 })
    tokenHash: string;

    /** The re-copyable token, encrypted at rest. Read only for the Tenant owner. */
    @EncryptedJsonColumn()
    tokenEncrypted: SharedViewTokenEnvelope;

    /** `active` resolves; `paused` keeps the token but refuses every request. */
    @Column({ type: 'varchar', length: 16, default: 'active' })
    status: SharedViewStatus;

    /** Which sections are published. */
    @Column({ type: 'simple-json' })
    sections: SharedViewSectionsDto;

    /** Knowledge Base classes selected for publication. Empty publishes nothing. */
    @Column({ type: 'simple-json' })
    knowledgeClasses: string[];

    /** Crawlers are told to stay away unless this is true. */
    @Column({ type: 'boolean', default: false })
    searchIndexable: boolean;

    /** Counted views (a client at most once per ten minutes). */
    @Column({ type: 'int', default: 0 })
    viewCount: number;

    @PortableDateColumn({ nullable: true })
    lastViewedAt?: Date | null;

    /** Set once the first view of the current link has notified the owner; cleared on regenerate. */
    @PortableDateColumn({ nullable: true })
    firstViewNotifiedAt?: Date | null;

    /** When the link was last regenerated. */
    @PortableDateColumn({ nullable: true })
    tokenRotatedAt?: Date | null;

    /** Regenerations so far — also the revocation counter every view session is checked against. */
    @Column({ type: 'int', default: 0 })
    rotationCount: number;

    /** Who first turned sharing on. */
    @Column({ type: 'uuid' })
    createdById: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
