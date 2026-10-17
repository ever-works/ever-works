import type { EmailAddressDirection } from '@/lib/api/email-addresses';

/*
 * EW-P4-3 — the email-provider choices the add-address wizard offers. A leaf
 * module (no React), so it is testable on its own.
 */

export interface EmailProviderOption {
    id: string;
    name: string;
    inbound: boolean;
    outbound: boolean;
    /** How the provider authenticates its inbound webhook (shown for inbound). */
    inboundSecret?: string;
}

/**
 * The shipped email-provider plugins (docs/features/agent-email.md). Only
 * Postmark and Mailgun can receive mail.
 */
export const EMAIL_PROVIDERS: readonly EmailProviderOption[] = [
    {
        id: 'postmark',
        name: 'Postmark',
        inbound: true,
        outbound: true,
        inboundSecret:
            'Set the Postmark plugin\'s "Inbound webhook secret" (Settings → Plugins) and register the URL with it as Basic auth: https://postmark:<secret>@…',
    },
    {
        id: 'mailgun',
        name: 'Mailgun',
        inbound: true,
        outbound: true,
        inboundSecret:
            'Set the Mailgun plugin\'s "Webhook signing key" (Settings → Plugins) and point a Mailgun route\'s forward() at the URL.',
    },
    { id: 'resend', name: 'Resend', inbound: false, outbound: true },
    { id: 'sendgrid', name: 'SendGrid', inbound: false, outbound: true },
    {
        id: 'mailchimp-transactional',
        name: 'Mailchimp Transactional (Mandrill)',
        inbound: false,
        outbound: true,
    },
];

export function providersFor(direction: EmailAddressDirection): EmailProviderOption[] {
    return EMAIL_PROVIDERS.filter((p) =>
        direction === 'outbound'
            ? p.outbound
            : direction === 'inbound'
              ? p.inbound
              : p.inbound && p.outbound,
    );
}
