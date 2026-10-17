import type { DomainEventAggregateType, DomainEventType } from './domain-event-catalog.js';

/**
 * The domain event envelope (integration contract v1, B.3).
 *
 * One shape for the integration change feed (`GET /api/integrations/v1/events`),
 * webhooks v2 (one envelope per POST) and EW plugins
 * (`IDomainEventSubscriberPlugin.onDomainEvent`). Published JSON Schema:
 * `docs/specs/features/integrations-api-v1/contract/schemas/event-envelope.schema.json`.
 */

/** Who caused a change. */
export const DOMAIN_EVENT_ACTOR_TYPES = ['user', 'agent', 'integration', 'system'] as const;

export type DomainEventActorType = (typeof DOMAIN_EVENT_ACTOR_TYPES)[number];

export interface DomainEventActor {
	readonly type: DomainEventActorType;
	/** `users.id`, `agents.id`, the integration key id, or a stable system id (`pr-status-cron`, `system`). */
	readonly id: string;
	/** Display label at the time of the change. */
	readonly label?: string | null;
}

export interface DomainEventAggregateRef {
	readonly type: DomainEventAggregateType;
	readonly id: string;
	/**
	 * The aggregate's version AFTER the change. For child events this is the
	 * parent's new version; for `*.deleted` it is the last version + 1; for
	 * `task.runtime_updated` it is the unchanged current version.
	 */
	readonly version: number;
}

/** Loop-prevention marker: the `X-Sync-Origin` of the write that caused the event. */
export interface DomainEventOrigin {
	readonly tag: string | null;
	readonly integrationKeyId: string | null;
}

export interface DomainEventEnvelope<
	TData extends Record<string, unknown> = Record<string, unknown>,
	TType extends string = DomainEventType
> {
	/** `evt_<ULID>`: the consumer's dedupe key. */
	readonly id: string;
	/**
	 * Feed position: decimal string of `domain_events.seq`, assigned by the
	 * relay at dispatch — strictly increasing and gap-free, so paging with
	 * `after=<seq>` never misses a committed event.
	 */
	readonly seq: string;
	readonly type: TType;
	/** Payload schema version (1 for every catalog v1 type). */
	readonly version: number;
	/** ISO-8601 UTC. */
	readonly occurredAt: string;
	/**
	 * Always set on the integration feed and webhooks. In-process listeners can
	 * see `null` for a legacy personal-scope row that never had a tenant.
	 */
	readonly tenantId: string | null;
	/** `null` for personal scope; such events are never served to integrations. */
	readonly organizationId: string | null;
	readonly aggregate: DomainEventAggregateRef;
	readonly actor: DomainEventActor;
	readonly origin: DomainEventOrigin;
	/** DTO field names that changed (empty for created / deleted). */
	readonly changedFields: readonly string[];
	/** Full post-change snapshot in the integration DTO shape (or the child DTO). */
	readonly data: TData;
	/** Previous values of `changedFields` only. */
	readonly previous: Record<string, unknown>;
	readonly correlationId?: string | null;
}

/** The EventEmitter2 event name the relay emits an envelope under: `domain.<type>`. */
export function domainEventEmitterName(type: string): string {
	return `domain.${type}`;
}

/** The `X-Sync-Origin` request header. */
export const SYNC_ORIGIN_HEADER = 'x-sync-origin';

/** Longest accepted `X-Sync-Origin` value (the `originTag` column width). */
export const SYNC_ORIGIN_MAX_LENGTH = 100;
