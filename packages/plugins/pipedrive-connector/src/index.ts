/**
 * @ever-works/pipedrive-connector-plugin — Pipedrive CRM connector.
 * Outbound notes + record writes via the official `pipedrive` Node SDK;
 * `pullEvents` event-source leg (deals, persons and organizations
 * changed since the watermark via `/recents`, opt-in historical
 * backfill) feeding the platform event-ingest spine.
 */
export {
	PipedriveConnectorPlugin,
	pipedriveConnectorPlugin,
	asEntityType,
	clampBackfillDays,
	isoToPipedriveTime,
	pipedriveTimeToIso,
	resolveEntityTypes,
	resolveNoteTarget,
	PIPEDRIVE_EVENT_TEXT_MAX_CHARS,
	PIPEDRIVE_PULL_PAGE_SIZE,
	PIPEDRIVE_BACKFILL_MAX_PAGES,
	PIPEDRIVE_ENTITY_TYPES,
	PIPEDRIVE_ENTITY_META
} from './pipedrive-connector-plugin.js';
export type { PipedriveEntityType } from './pipedrive-connector-plugin.js';

// The plugin loader resolves `module.default` first. Without a default
// export, `import()` of the CJS build hands back the whole namespace
// object (no __esModule marker), which fails the plugin-class check at
// materialization time — the plugin registers from its manifest and then
// dies on first use. Every loadable first-party plugin re-exports its
// class as default; keep this in sync with the class above.
export { PipedriveConnectorPlugin as default } from './pipedrive-connector-plugin.js';
