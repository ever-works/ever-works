import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/** The Ever Works record types an external record can be linked to (contract v1 `link.schema.json`). */
export const EXTERNAL_LINK_ENTITY_TYPES = [
    'member',
    'agent',
    'team',
    'work',
    'mission',
    'goal',
    'idea',
    'task',
    'task_comment',
    'inbox_item',
    'kb_document',
    'kb_folder',
] as const;

export type ExternalLinkEntityType = (typeof EXTERNAL_LINK_ENTITY_TYPES)[number];

/**
 * One Ever Works record ↔ one record of an external system (EW-P1-4,
 * integration contract v1 B.6 "Links" and `externalRef` on creates).
 *
 * Org-scoped and unique on BOTH sides per
 * `(organizationId, source, installation, entityType)`: one Gauzy task maps
 * to one Ever Works task and back, per Gauzy connection.
 *
 * `installationKey` is the installation (for Gauzy: the connection id), stored
 * as `''` when there is none — a NULL would let two rows without an
 * installation collide silently, since NULLs never match in a unique index.
 * The DTO answers `installationId: null` for `''`.
 */
@Entity({ name: 'external_record_links' })
@Index(
    'uq_external_record_links_external',
    ['organizationId', 'source', 'installationKey', 'entityType', 'externalId'],
    { unique: true },
)
@Index(
    'uq_external_record_links_entity',
    ['organizationId', 'source', 'installationKey', 'entityType', 'entityId'],
    { unique: true },
)
@Index('idx_external_record_links_entity', ['entityType', 'entityId'])
export class ExternalRecordLink {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid', nullable: true })
    tenantId?: string | null;

    @Column({ type: 'uuid' })
    organizationId: string;

    @Column({ type: 'varchar', length: 32 })
    entityType: ExternalLinkEntityType;

    @Column({ type: 'varchar', length: 64 })
    entityId: string;

    /** The external system, e.g. `gauzy` (from the key's `integrationKind`). */
    @Column({ type: 'varchar', length: 100 })
    source: string;

    /** The installation (Gauzy connection id), `''` when none. */
    @Column({ type: 'varchar', length: 200, default: '' })
    installationKey: string;

    @Column({ type: 'varchar', length: 200 })
    externalId: string;

    @Column({ type: 'varchar', length: 2048, nullable: true })
    externalUrl?: string | null;

    /** The integration key that created or last changed the link. */
    @Column({ type: 'uuid', nullable: true })
    integrationKeyId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
