import { describe, expect, it } from 'vitest';

import { EMAIL_PROVIDERS, providersFor } from './email-providers';

/**
 * EW-P4-3 — the wizard only offers a provider that can do what the address
 * is for: only Postmark and Mailgun can receive mail.
 */
describe('AddEmailAddressWizard providersFor', () => {
    it('offers every provider for sending', () => {
        expect(providersFor('outbound').map((p) => p.id)).toEqual(EMAIL_PROVIDERS.map((p) => p.id));
    });

    it('offers only inbound-capable providers for receiving, or for both', () => {
        expect(providersFor('inbound').map((p) => p.id)).toEqual(['postmark', 'mailgun']);
        expect(providersFor('both').map((p) => p.id)).toEqual(['postmark', 'mailgun']);
    });

    it('tells the operator how each inbound provider authenticates its webhook', () => {
        for (const provider of providersFor('inbound')) {
            expect(provider.inboundSecret).toBeTruthy();
        }
    });
});
