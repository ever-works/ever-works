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

// The plugin loader resolves `module.default` first. Without a default
// export, `import()` of the CJS build hands back the whole namespace
// object (no __esModule marker), which fails the plugin-class check at
// materialization time — the plugin registers from its manifest and then
// dies on first use. Every loadable first-party plugin re-exports its
// class as default; keep this in sync with the class above.
export { SlackConnectorPlugin as default } from './slack-connector-plugin.js';
