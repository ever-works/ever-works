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
