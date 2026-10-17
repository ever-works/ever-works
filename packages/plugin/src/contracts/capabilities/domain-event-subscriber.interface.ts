import type { DomainEventEnvelope } from '@ever-works/contracts';
import type { IPlugin } from '../plugin.interface.js';

/**
 * The `domain-event-subscriber` capability (EW-P1-1) — how an EW plugin
 * follows Ever Works' durable domain events (`task.updated`,
 * `team.member.added`, …) without polling.
 *
 * The platform records every event in its `domain_events` outbox in the same
 * transaction as the change, and a single-leader relay hands each one to the
 * subscribed plugins:
 *
 *  - **At least once.** Delivery is tracked per plugin and tenant by a cursor
 *    (`plugin_event_cursors.lastSeq`) that only advances after
 *    `onDomainEvent` resolves. A plugin that was down, or that threw, gets the
 *    event again; dedupe on `event.id`.
 *  - **In order per tenant.** Events arrive in ascending `seq` order. A plugin
 *    is never handed event N+1 of a tenant before N resolved (or was
 *    dead-lettered).
 *  - **Only enabled tenants.** A plugin only receives events of tenants where
 *    it is enabled.
 *  - **Bounded.** Each call has a timeout (`DOMAIN_EVENTS_PLUGIN_TIMEOUT_MS`,
 *    default 10 s). After 10 consecutive failures on one event, that event is
 *    dead-lettered (logged and counted on the cursor) and delivery moves on.
 *
 * `subscribes` takes catalog types (`goal.completed`), `<prefix>.*` wildcards
 * (`task.*`) and `*`. Opt-in types such as `task.runtime_updated` are only
 * delivered to an exact pattern. See `matchesDomainEventPattern` in
 * `@ever-works/contracts` and `docs/specs/features/domain-events/spec.md`.
 */
export const DOMAIN_EVENT_SUBSCRIBER_CAPABILITY = 'domain-event-subscriber' as const;

/** What the platform tells a plugin about the delivery it is handling. */
export interface PluginEventContext {
	/** Tenant the event belongs to (the cursor's tenant). */
	readonly tenantId: string;
	/** 1 on the first try; higher when this event is being re-delivered. */
	readonly attempt: number;
	/** Aborted when the per-call timeout elapses or the platform shuts down. */
	readonly signal: AbortSignal;
}

export interface IDomainEventSubscriberPlugin extends IPlugin {
	/** Patterns this plugin wants, e.g. `['task.*', 'goal.completed']`. */
	readonly subscribes: readonly string[];
	/** Handle one event. Resolve to acknowledge; throw (or time out) to have it re-delivered. */
	onDomainEvent(event: DomainEventEnvelope, ctx: PluginEventContext): Promise<void>;
}

/** Runtime guard: declares the capability, lists its patterns AND implements `onDomainEvent`. */
export function isDomainEventSubscriberPlugin(plugin: unknown): plugin is IDomainEventSubscriberPlugin {
	if (!plugin || typeof plugin !== 'object') return false;
	const candidate = plugin as Partial<IDomainEventSubscriberPlugin>;
	return (
		Array.isArray(candidate.capabilities) &&
		candidate.capabilities.includes(DOMAIN_EVENT_SUBSCRIBER_CAPABILITY) &&
		Array.isArray(candidate.subscribes) &&
		candidate.subscribes.every((pattern) => typeof pattern === 'string' && pattern.length > 0) &&
		typeof candidate.onDomainEvent === 'function'
	);
}
