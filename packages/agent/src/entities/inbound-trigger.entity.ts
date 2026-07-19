import {
	Entity,
	Column,
	PrimaryGeneratedColumn,
	Index,
	CreateDateColumn,
	UpdateDateColumn,
} from 'typeorm';
import { TimestampColumn } from './_types';

/** Delivery style the trigger was created for (informational — both fire the same endpoint). */
export type InboundTriggerKind = 'webhook' | 'api';

export type InboundTriggerStatus = 'active' | 'paused';

/**
 * Inbound Triggers ("Trigger Schedules") — event-driven ops without polling.
 *
 * One row per named trigger an org member creates. The platform hands the
 * creator a signed webhook URL (`POST /api/inbound-triggers/:id/fire`);
 * an external system POSTs to it, the platform verifies the HMAC-SHA256
 * signature + replay window, and spawns a Task (optionally assigned to
 * `targetAgentId`).
 *
 * Secret model mirrors `webhook_subscriptions.secretEncrypted`: the HMAC
 * signing secret is AES-256-GCM-encrypted at rest via
 * `WebhookSubscriptionSecretService` (PLATFORM_ENCRYPTION_KEY envelope)
 * and the raw value is returned ONCE on create / rotate. Rotation keeps
 * the previous secret accepted for a 24h grace window
 * (`previousSecretEncrypted` + `rotatedAt`) so external senders can roll
 * without a hard cutover.
 *
 * Tier A scope shape (EW-655): nullable `tenantId` / `organizationId`
 * uuid columns auto-stamped by `ScopeStampingSubscriber`; `userId` and
 * `targetAgentId` are RAW uuid columns (no @ManyToOne — cycle avoidance
 * per EW-654); FKs + indexes live in migration
 * `1782100000000-CreateInboundTriggers`.
 */
@Entity({ name: 'inbound_triggers' })
@Index('idx_inbound_triggers_user', ['userId'])
@Index('idx_inbound_triggers_org_status', ['organizationId', 'status'])
export class InboundTrigger {
	@PrimaryGeneratedColumn('uuid')
	id: string;

	/** Owning user (raw uuid — FK in the migration). */
	@Column({ type: 'uuid' })
	userId: string;

	@Column({ type: 'varchar', length: 120 })
	name: string;

	@Column({ type: 'text', nullable: true })
	description: string | null;

	@Column({ type: 'varchar', length: 16, default: 'webhook' })
	kind: InboundTriggerKind;

	@Column({ type: 'varchar', length: 16, default: 'active' })
	status: InboundTriggerStatus;

	/**
	 * HMAC-SHA256 signing secret, encrypted at rest.
	 * x-secret: true — never log or echo this column.
	 */
	@Column({ type: 'text' })
	secretEncrypted: string;

	/**
	 * Previous signing secret (encrypted) — accepted alongside the current
	 * one for ROTATION_GRACE_MS (24h) after `rotatedAt`, then dead.
	 * x-secret: true — never log or echo this column.
	 */
	@Column({ type: 'text', nullable: true })
	previousSecretEncrypted: string | null;

	/** When the secret was last rotated (starts the 24h grace window). */
	@TimestampColumn({ nullable: true })
	rotatedAt: Date | null;

	/** Optional Agent assigned to spawned Tasks (raw uuid — FK in the migration). */
	@Column({ type: 'uuid', nullable: true })
	targetAgentId: string | null;

	/** Title template for spawned Tasks; `{name}` → trigger name. Defaults to 'Trigger: {name}'. */
	@Column({ type: 'varchar', length: 200, nullable: true })
	taskTitleTemplate: string | null;

	@TimestampColumn({ nullable: true })
	lastFiredAt: Date | null;

	@Column({ type: 'int', default: 0 })
	fireCount: number;

	// Tier A scope FKs (EW-655) — nullable, auto-stamped on insert by
	// ScopeStampingSubscriber. No @ManyToOne to avoid the entities
	// import cycle that bit Phase 2 — see user.entity.ts EW-654 comment.
	@Column({ type: 'uuid', nullable: true })
	tenantId?: string | null;

	@Column({ type: 'uuid', nullable: true })
	organizationId?: string | null;

	@CreateDateColumn()
	createdAt: Date;

	@UpdateDateColumn()
	updatedAt: Date;
}
