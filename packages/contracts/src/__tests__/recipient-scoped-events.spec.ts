import { describe, expect, it } from 'vitest';

import {
	DOMAIN_EVENT_TYPES,
	RECIPIENT_EVENT_SCOPES,
	RECIPIENT_EVENT_VISIBILITY,
	recipientScopeForEventType
} from '../events/index.js';
import { INTEGRATION_SCOPES } from '../integrations/index.js';

/**
 * Recipient-scoped domain events (EW-P3-1): one person's messages reach an
 * integration only with the domain's read scope, decided by the event TYPE.
 */
describe('recipient-scoped domain events', () => {
	it('gates the inbox and email domains by their read scope', () => {
		expect(recipientScopeForEventType('inbox.item.answered')).toBe('inbox:read');
		expect(recipientScopeForEventType('inbox.item.deleted')).toBe('inbox:read');
		expect(recipientScopeForEventType('email.message.received')).toBe('email:read');
	});

	it('leaves every other catalog type to events:read alone', () => {
		for (const type of DOMAIN_EVENT_TYPES) {
			const scope = recipientScopeForEventType(type);
			if (type.startsWith('inbox.') || type.startsWith('email.')) expect(scope).not.toBeNull();
			else expect(scope).toBeNull();
		}
		expect(recipientScopeForEventType('toString.x')).toBeNull();
		expect(recipientScopeForEventType('inbox')).toBe('inbox:read');
	});

	it('names only v1 scopes, and a visibility marker that fits the outbox column (16)', () => {
		for (const scope of RECIPIENT_EVENT_SCOPES) expect(INTEGRATION_SCOPES).toContain(scope);
		expect(RECIPIENT_EVENT_VISIBILITY.length).toBeLessThanOrEqual(16);
	});
});
