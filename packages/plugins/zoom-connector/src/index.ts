/**
 * @ever-works/zoom-connector-plugin — Zoom connector (Wave 8,
 * Meetings v1). `pullEvents` event-source leg sweeps completed cloud
 * recordings (with transcripts when available, opt-in historical
 * backfill) via the official `@zoom/rivet` SDK (Server-to-Server
 * OAuth), feeding the platform event-ingest spine as `zoom.recording`
 * envelopes that the Meetings processor turns into Meeting rows.
 */
export {
	ZoomConnectorPlugin,
	zoomConnectorPlugin,
	clampBackfillDays,
	parseVttToText,
	ZOOM_TRANSCRIPT_MAX_CHARS,
	ZOOM_PULL_PAGE_SIZE,
	ZOOM_WINDOW_MAX_DAYS,
	ZOOM_BACKFILL_MAX_PAGES
} from './zoom-connector-plugin.js';
export type {
	ZoomClientLike,
	ZoomRecordingsPage,
	ZoomRecordingMeetingNode,
	ZoomRecordingFileNode
} from './zoom-connector-plugin.js';
