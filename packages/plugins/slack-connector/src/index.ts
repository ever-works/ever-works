/**
 * @ever-works/slack-connector-plugin — Slack connector (bidirectional).
 * Outbound `chat.postMessage` + threaded `reply` via `@slack/web-api`;
 * inbound Events API verification/challenge/parsing; `pullEvents`
 * event-source leg feeding the platform event-ingest spine. See
 * `docs/specs/features/connectors/spec.md` §7.5.1.
 */
export {
	SlackConnectorPlugin,
	slackConnectorPlugin,
	slackTsToIso,
	isoToSlackTs,
	SLACK_EVENT_TEXT_MAX_CHARS
} from './slack-connector-plugin.js';
export {
	computeSlackSignature,
	verifySlackSignature,
	SLACK_SIGNATURE_TOLERANCE_SECONDS,
	type SlackSignatureInput,
	type SlackSignatureResult
} from './slack-signature.js';
