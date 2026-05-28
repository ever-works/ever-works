/**
 * @ever-works/sendgrid-plugin — Twilio SendGrid email provider (outbound).
 *
 * Inbound (SendGrid Inbound Parse) is a separate webhook surface; add an
 * `IEmailInboundPlugin` here when that capability is needed. See
 * `docs/specs/features/email-providers/spec.md` §6.
 */
export { SendGridPlugin, sendgridPlugin } from './sendgrid-plugin.js';
