/**
 * @ever-works/postmark-plugin — Postmark email provider for the Ever
 * Works platform. Implements both `IEmailOutboundPlugin` (Server API
 * send) and `IEmailInboundPlugin` (Inbound Streams webhook parser).
 *
 * See `docs/specs/features/email-providers/spec.md` §6 (provider table)
 * and the canonical contracts in `@ever-works/plugin`.
 */
export { PostmarkPlugin, postmarkPlugin } from './postmark-plugin.js';
