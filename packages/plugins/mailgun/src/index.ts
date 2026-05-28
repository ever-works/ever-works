/**
 * @ever-works/mailgun-plugin — Mailgun email provider (outbound + inbound).
 *
 * See `docs/specs/features/email-providers/spec.md` §6. Inbound verifies
 * the Mailgun HMAC-SHA256 webhook signature before parsing.
 */
export { MailgunPlugin, mailgunPlugin } from './mailgun-plugin.js';
