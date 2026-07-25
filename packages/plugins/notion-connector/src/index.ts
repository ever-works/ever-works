/**
 * @ever-works/notion-connector-plugin — Notion connector (Wave 8).
 * Outbound page comments via the official `@notionhq/client`;
 * `pullEvents` event-source leg (pages created/edited since watermark,
 * opt-in historical backfill) feeding the platform event-ingest spine.
 */
export {
	NotionConnectorPlugin,
	notionConnectorPlugin,
	clampBackfillDays,
	extractPageTitle,
	NOTION_EVENT_TEXT_MAX_CHARS,
	NOTION_PULL_PAGE_SIZE,
	NOTION_BACKFILL_MAX_PAGES
} from './notion-connector-plugin.js';

// The plugin loader resolves `module.default` first. Without a default
// export, `import()` of the CJS build hands back the whole namespace
// object (no __esModule marker), which fails the plugin-class check at
// materialization time — the plugin registers from its manifest and then
// dies on first use. Every loadable first-party plugin re-exports its
// class as default; keep this in sync with the class above.
export { NotionConnectorPlugin as default } from './notion-connector-plugin.js';
