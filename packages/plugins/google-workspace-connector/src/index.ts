/**
 * @ever-works/google-workspace-connector-plugin — Google Workspace
 * connector (Wave 8). Read-only `pullEvents` event-source leg over
 * Drive file changes and Calendar events (plus Google Meet transcript
 * documents, exported as `google.meet-recording` envelopes) feeding the
 * platform event-ingest spine.
 */
export {
	GoogleWorkspaceConnectorPlugin,
	googleWorkspaceConnectorPlugin,
	clampBackfillDays,
	resolveSurfaces,
	resolveDriveFolderIds,
	resolveCalendarIds,
	isMeetTranscriptFile,
	buildDriveQuery,
	GOOGLE_EVENT_TEXT_MAX_CHARS,
	GOOGLE_TRANSCRIPT_MAX_CHARS,
	GOOGLE_PULL_PAGE_SIZE,
	GOOGLE_BACKFILL_MAX_PAGES,
	GOOGLE_DOC_MIME_TYPE,
	GOOGLE_SURFACES
} from './google-workspace-connector-plugin.js';
export type { GoogleSurface } from './google-workspace-connector-plugin.js';

// The plugin loader resolves `module.default` first. Without a default
// export, `import()` of the CJS build hands back the whole namespace
// object (no __esModule marker), which fails the plugin-class check at
// materialization time — the plugin registers from its manifest and then
// dies on first use. Every loadable first-party plugin re-exports its
// class as default; keep this in sync with the class above.
export { GoogleWorkspaceConnectorPlugin as default } from './google-workspace-connector-plugin.js';
