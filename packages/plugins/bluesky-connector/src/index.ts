/**
 * @ever-works/bluesky-connector-plugin — Bluesky (AT Protocol) social
 * connector. Outbound posts/threaded replies via the official
 * `@atproto/api` SDK; `pullEvents` event-source leg (notifications then
 * the account's own posts since the watermark, opt-in historical
 * backfill) feeding the platform event-ingest spine.
 */
export {
	BlueskyConnectorPlugin,
	blueskyConnectorPlugin,
	clampBackfillDays,
	postUrlFromAtUri,
	resolveCredentials,
	BLUESKY_EVENT_TEXT_MAX_CHARS,
	BLUESKY_PULL_PAGE_SIZE,
	BLUESKY_BACKFILL_MAX_PAGES,
	BLUESKY_DEFAULT_SERVICE
} from './bluesky-connector-plugin.js';

// The plugin loader resolves `module.default` first. Without a default
// export, `import()` of the CJS build hands back the whole namespace
// object (no __esModule marker), which fails the plugin-class check at
// materialization time — the plugin registers from its manifest and then
// dies on first use. Every loadable first-party plugin re-exports its
// class as default; keep this in sync with the class above.
export { BlueskyConnectorPlugin as default } from './bluesky-connector-plugin.js';
