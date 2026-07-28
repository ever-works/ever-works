/**
 * @ever-works/mastodon-connector-plugin — Mastodon social connector.
 * Outbound statuses/threaded replies via the `masto` SDK against the
 * operator's own instance (SSRF-guarded URL); `pullEvents` event-source
 * leg (notifications then the account's own statuses since the
 * watermark, opt-in historical backfill) feeding the platform
 * event-ingest spine.
 */
export {
	MastodonConnectorPlugin,
	mastodonConnectorPlugin,
	clampBackfillDays,
	resolveCredentials,
	resolveVisibility,
	stripStatusHtml,
	MASTODON_EVENT_TEXT_MAX_CHARS,
	MASTODON_PULL_PAGE_SIZE,
	MASTODON_BACKFILL_MAX_PAGES,
	MASTODON_VISIBILITIES
} from './mastodon-connector-plugin.js';
export type { MastodonVisibility } from './mastodon-connector-plugin.js';

// The plugin loader resolves `module.default` first. Without a default
// export, `import()` of the CJS build hands back the whole namespace
// object (no __esModule marker), which fails the plugin-class check at
// materialization time — the plugin registers from its manifest and then
// dies on first use. Every loadable first-party plugin re-exports its
// class as default; keep this in sync with the class above.
export { MastodonConnectorPlugin as default } from './mastodon-connector-plugin.js';
