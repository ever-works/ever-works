/**
 * @ever-works/slack-connector-plugin — Slack connector (bidirectional).
 * Outbound `chat.postMessage` via `@slack/web-api`; inbound Events API
 * routing lands in a follow-up. See
 * `docs/specs/features/connectors/spec.md` §7.5.1.
 */
export { SlackConnectorPlugin, slackConnectorPlugin } from './slack-connector-plugin.js';
