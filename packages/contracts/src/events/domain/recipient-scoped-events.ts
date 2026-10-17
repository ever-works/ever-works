import type { IntegrationScope } from '../../integrations/integration-keys.types.js';

/**
 * Recipient-scoped domain events (EW-P3-1, integration contract v1-draft.4).
 *
 * Some aggregates are ONE person's messages, not organization records: an
 * inbox item (the question an agent asked them, their approval, their answer)
 * and, from P4, an agent's email. Their events are still organization-scoped
 * in the outbox, but they reach an integration only when its key holds the
 * domain's read scope — the same scope that lets it `GET` them — and they
 * never reach a user-owned webhook subscription (another member of the
 * organization would otherwise receive somebody else's messages).
 *
 * The recorder stamps them `visibility: 'recipient'`
 * ({@link RECIPIENT_EVENT_VISIBILITY}); the feed and the webhooks v2 fan-out
 * gate them by TYPE through {@link recipientScopeForEventType}, so an event of
 * these domains is never served without the scope whatever its visibility.
 */
export const RECIPIENT_EVENT_VISIBILITY = 'recipient';

/** Event domain → the read scope a caller needs to receive its events. */
export const RECIPIENT_SCOPED_EVENT_DOMAINS: Readonly<Record<string, IntegrationScope>> = {
	inbox: 'inbox:read',
	email: 'email:read'
};

/**
 * The read scope a caller needs to receive events of `type`
 * (`inbox.item.answered` → `inbox:read`), or `null` for an ordinary
 * organization event that `events:read` alone serves.
 */
export function recipientScopeForEventType(type: string): IntegrationScope | null {
	const dot = type.indexOf('.');
	const domain = dot < 0 ? type : type.slice(0, dot);
	return Object.prototype.hasOwnProperty.call(RECIPIENT_SCOPED_EVENT_DOMAINS, domain)
		? RECIPIENT_SCOPED_EVENT_DOMAINS[domain]
		: null;
}

/** Every scope {@link recipientScopeForEventType} can answer (a fan-out that reads for all owners). */
export const RECIPIENT_EVENT_SCOPES: readonly IntegrationScope[] = Object.values(RECIPIENT_SCOPED_EVENT_DOMAINS);
