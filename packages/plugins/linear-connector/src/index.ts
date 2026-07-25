/**
 * @ever-works/linear-connector-plugin — Linear connector (Wave 8).
 * Outbound issue comments via the official `@linear/sdk`; `pullEvents`
 * event-source leg (issues + comments since watermark, opt-in
 * historical backfill) feeding the platform event-ingest spine.
 */
export {
	LinearConnectorPlugin,
	linearConnectorPlugin,
	clampBackfillDays,
	LINEAR_EVENT_TEXT_MAX_CHARS,
	LINEAR_PULL_PAGE_SIZE,
	LINEAR_BACKFILL_MAX_PAGES
} from './linear-connector-plugin.js';

// The plugin loader resolves `module.default` first. Without a default
// export, `import()` of the CJS build hands back the whole namespace
// object (no __esModule marker), which fails the plugin-class check at
// materialization time — the plugin registers from its manifest and then
// dies on first use. Every loadable first-party plugin re-exports its
// class as default; keep this in sync with the class above.
export { LinearConnectorPlugin as default } from './linear-connector-plugin.js';
