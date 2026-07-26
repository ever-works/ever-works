/**
 * @ever-works/jira-connector-plugin — JIRA connector (Wave 8).
 * Outbound issue comments via the `jira.js` Cloud REST client;
 * `pullEvents` event-source leg (issues + their changed comments since
 * the watermark, opt-in historical backfill) feeding the platform
 * event-ingest spine.
 */
export {
	JiraConnectorPlugin,
	jiraConnectorPlugin,
	clampBackfillDays,
	normalizeBaseUrl,
	resolveProjectKeys,
	buildJql,
	toJqlDateTime,
	adfToText,
	JIRA_EVENT_TEXT_MAX_CHARS,
	JIRA_PULL_PAGE_SIZE,
	JIRA_BACKFILL_MAX_PAGES,
	JIRA_ISSUE_FIELDS
} from './jira-connector-plugin.js';

// The plugin loader resolves `module.default` first. Without a default
// export, `import()` of the CJS build hands back the whole namespace
// object (no __esModule marker), which fails the plugin-class check at
// materialization time — the plugin registers from its manifest and then
// dies on first use. Every loadable first-party plugin re-exports its
// class as default; keep this in sync with the class above.
export { JiraConnectorPlugin as default } from './jira-connector-plugin.js';
