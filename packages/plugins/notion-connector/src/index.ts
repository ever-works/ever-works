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
