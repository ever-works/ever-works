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
 * Per-plugin, per-tenant delivery cursor of domain events (EW-P1-1).
 *
 * A plugin that declares the `domain-event-subscriber` capability receives
 * the events of each tenant where it is enabled, in feed (`seq`) order, at
 * least once: `lastSeq` only advances after `onDomainEvent` resolves, so a
 * plugin that was down — or that threw — catches up from here.
 *
 * After `DOMAIN_EVENT_PLUGIN_MAX_FAILURES` consecutive failures on ONE event,
 * that event is dead-lettered: logged, counted in `deadLetterCount`, its id kept
 * in `lastDeadLetterEventId`, and the cursor moves past it.
 */
@Entity({ name: 'plugin_event_cursors' })
@Index('uq_plugin_event_cursors_plugin_tenant', ['pluginId', 'tenantId'], { unique: true })
export class PluginEventCursor {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'varchar', length: 100 })
    pluginId: string;

    @Column({ type: 'uuid' })
    tenantId: string;

    /** Last feed position delivered (or dead-lettered). `bigint`: read through `String(...)`. */
    @Column({ type: 'bigint', default: 0 })
    lastSeq: string | number;

    /** Consecutive failures on the event right after `lastSeq`. */
    @Column({ type: 'int', default: 0 })
    consecutiveFailures: number;

    @Column({ type: 'text', nullable: true })
    lastError?: string | null;

    @PortableDateColumn({ nullable: true })
    lastErrorAt?: Date | null;

    @Column({ type: 'int', default: 0 })
    deadLetterCount: number;

    @Column({ type: 'varchar', length: 32, nullable: true })
    lastDeadLetterEventId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
