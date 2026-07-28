/**
 * @ever-works/hubspot-connector-plugin — HubSpot CRM connector.
 * Outbound notes + CRM record writes via the official
 * `@hubspot/api-client`; `pullEvents` event-source leg (contacts,
 * companies, deals since the watermark, opt-in historical backfill)
 * feeding the platform event-ingest spine.
 */
export {
	HubSpotConnectorPlugin,
	hubspotConnectorPlugin,
	clampBackfillDays,
	objectMeta,
	recordTitle,
	resolveNoteTarget,
	resolveObjectTypes,
	HUBSPOT_EVENT_TEXT_MAX_CHARS,
	HUBSPOT_PULL_PAGE_SIZE,
	HUBSPOT_BACKFILL_MAX_PAGES,
	HUBSPOT_DEFAULT_OBJECT_TYPES,
	HUBSPOT_OBJECT_META
} from './hubspot-connector-plugin.js';

// The plugin loader resolves `module.default` first. Without a default
// export, `import()` of the CJS build hands back the whole namespace
// object (no __esModule marker), which fails the plugin-class check at
// materialization time — the plugin registers from its manifest and then
// dies on first use. Every loadable first-party plugin re-exports its
// class as default; keep this in sync with the class above.
export { HubSpotConnectorPlugin as default } from './hubspot-connector-plugin.js';
