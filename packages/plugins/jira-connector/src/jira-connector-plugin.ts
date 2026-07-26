import { randomUUID } from 'node:crypto';
import { Version3Client } from 'jira.js';
import type {
	IConnectorPlugin,
	IEventSourcePlugin,
	ConnectorMetadata,
	ConnectorCallOptions,
	ChannelSendInput,
	ChannelSendResult,
	ChannelTargetConfig,
	ChannelVerification,
	EventSourcePullInput,
	EventSourcePullResult,
	PluginCategory,
	PluginSettings,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, EventSourceNotConfiguredError } from '@ever-works/plugin';
import type { IngestedEventEnvelope } from '@ever-works/contracts';

/**
 * Payload text cap for ingested envelopes. Envelope payloads are
 * size-capped platform-side (32 KB serialized); issue descriptions and
 * comment bodies never need more than this to be useful in
 * Memory/Activities.
 */
export const JIRA_EVENT_TEXT_MAX_CHARS = 4000;

/** Issues requested per JQL page. */
export const JIRA_PULL_PAGE_SIZE = 50;

/**
 * Historical backfill bound: at most this many pages during the opt-in
 * first-pull backfill, so a large site can never turn activation into an
 * unbounded crawl.
 */
export const JIRA_BACKFILL_MAX_PAGES = 10;

/** Fields requested per issue — comments ride along (see the class doc). */
export const JIRA_ISSUE_FIELDS = [
	'summary',
	'description',
	'created',
	'updated',
	'project',
	'status',
	'issuetype',
	'comment'
] as const;

/** Clamp the opt-in backfill window to the supported 0–90 day range. */
export function clampBackfillDays(value: unknown): number {
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num) || num <= 0) return 0;
	return Math.min(Math.floor(num), 90);
}

function truncateText(text: string): string {
	return text.length > JIRA_EVENT_TEXT_MAX_CHARS ? text.slice(0, JIRA_EVENT_TEXT_MAX_CHARS) : text;
}

/**
 * Private / loopback hostnames a JIRA "site" must never resolve to.
 *
 * Unlike every sibling connector, this one takes its host from user
 * settings (a JIRA site is per-customer), so the base URL is an SSRF
 * surface. Kept as a syntactic guard: obvious loopback / link-local /
 * RFC-1918 literals are rejected outright, and only `https:` is allowed.
 */
const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
	/^localhost$/i,
	/^127(?:\.\d{1,3}){3}$/,
	/^0\.0\.0\.0$/,
	/^10(?:\.\d{1,3}){3}$/,
	/^192\.168(?:\.\d{1,3}){2}$/,
	/^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
	/^169\.254(?:\.\d{1,3}){2}$/,
	/^\[?::1\]?$/,
	/\.local$/i,
	/\.internal$/i
];

/**
 * Validate + normalize the configured site URL. Returns the origin (no
 * path, no credentials) or `undefined` when the value is unusable.
 */
export function normalizeBaseUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.trim().length === 0) return undefined;
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (url.protocol !== 'https:') return undefined;
	if (url.username.length > 0 || url.password.length > 0) return undefined;
	const host = url.hostname;
	if (host.length === 0) return undefined;
	if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) return undefined;
	return url.origin;
}

/**
 * Parse the project filter list. JQL is a query language and these keys
 * are interpolated into it, so each entry is whitelisted against JIRA's
 * own project-key alphabet rather than escaped — anything else is
 * dropped. Splitting is comma-only (NOT whitespace, unlike the sibling
 * connectors whose ids are opaque request parameters): a tampered entry
 * such as `ENG) OR (1=1` must fail validation as a whole rather than
 * shed its punctuation and smuggle a bare `OR` through.
 */
export function resolveProjectKeys(settings: PluginSettings | undefined): string[] {
	const raw = settings?.projectKeys;
	if (typeof raw !== 'string' || raw.trim().length === 0) return [];
	return raw
		.split(',')
		.map((key) => key.trim().toUpperCase())
		.filter((key) => /^[A-Z][A-Z0-9_]{0,63}$/.test(key));
}

/** Extract a readable message from a `jira.js` error. */
function jiraErrorMessage(err: unknown): string {
	const e = err as { message?: string; response?: { data?: { errorMessages?: string[] } } };
	const apiMessage = e.response?.data?.errorMessages?.[0];
	return apiMessage ?? e.message ?? 'unknown error';
}

/** ISO 8601 | Date | undefined → ISO 8601 (epoch on garbage). */
function toIso(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	}
	return new Date(0).toISOString();
}

/**
 * ISO instant → the `yyyy-MM-dd HH:mm` literal JQL accepts.
 *
 * JQL evaluates bare date literals in the SITE's timezone while the
 * platform watermark is UTC, so the rendered window can be off by the
 * site's UTC offset. That is deliberate and safe in both directions:
 * dedupe is `(source, sourceEventId)`, so an over-wide window costs one
 * extra page and drops nothing, and each envelope re-checks `since`
 * itself before a comment is emitted.
 */
export function toJqlDateTime(iso: string): string {
	const ms = Date.parse(iso);
	const date = new Date(Number.isFinite(ms) ? ms : 0);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(
		date.getUTCHours()
	)}:${pad(date.getUTCMinutes())}`;
}

/** Build the bounded, ordered JQL the sweep runs. */
export function buildJql(since: string, projectKeys: string[]): string {
	const clauses = [`updated >= "${toJqlDateTime(since)}"`];
	if (projectKeys.length > 0) {
		clauses.push(`project in (${projectKeys.join(', ')})`);
	}
	return `${clauses.join(' AND ')} ORDER BY updated ASC`;
}

/** One node of an Atlassian Document Format tree (only what we read). */
interface AdfNode {
	type?: string;
	text?: string;
	content?: AdfNode[];
}

/**
 * ADF document → plain text. JIRA Cloud's v3 API returns rich text as
 * an Atlassian Document Format tree; envelopes carry plain text so
 * Memory/Activity rows stay readable. Block nodes are newline-joined,
 * inline nodes space-free-concatenated.
 */
export function adfToText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (!value || typeof value !== 'object') return '';
	const walk = (node: AdfNode): string => {
		if (typeof node.text === 'string') return node.text;
		const children = Array.isArray(node.content) ? node.content.map(walk) : [];
		const isBlock = node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem';
		return isBlock ? `${children.join('')}\n` : children.join('');
	};
	return walk(value as AdfNode)
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Opaque pull cursor. `n` is the API's `nextPageToken`, `s` the
 * effective since-watermark the sweep was started with (kept here so
 * later pages of the same sweep use the SAME window), `f` flags a
 * first-pull backfill sweep and `b` counts pages used (backfill page
 * bound). Malformed input restarts the sweep — safe, the ingest
 * pipeline dedupes on `(source, sourceEventId)`.
 */
interface JiraPullCursor {
	n?: string;
	s: string;
	f?: 1;
	b?: number;
}

function parsePullCursor(cursor: string | undefined): JiraPullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as JiraPullCursor;
		if (parsed && typeof parsed.s === 'string') return parsed;
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** Minimal scalar shape of a comment node we consume. */
export interface JiraCommentNode {
	id?: string;
	body?: unknown;
	created?: string;
	updated?: string;
	author?: { displayName?: string; accountId?: string };
}

/** Minimal scalar shape of an issue node we consume. */
export interface JiraIssueNode {
	id?: string;
	key?: string;
	fields?: {
		summary?: string;
		description?: unknown;
		created?: string;
		updated?: string;
		project?: { key?: string; name?: string; id?: string };
		status?: { name?: string };
		issuetype?: { name?: string };
		comment?: { comments?: JiraCommentNode[] };
	};
}

export interface JiraSearchPage {
	issues?: JiraIssueNode[];
	nextPageToken?: string;
}

/** The subset of the `jira.js` surface this plugin calls (testable seam). */
export interface JiraClientLike {
	getCurrentUser(): Promise<{ accountId?: string; displayName?: string; emailAddress?: string }>;
	searchIssues(params: {
		jql: string;
		maxResults: number;
		fields: string[];
		nextPageToken?: string;
	}): Promise<JiraSearchPage>;
	addComment(params: { issueIdOrKey: string; comment: string }): Promise<{ id?: string }>;
}

interface JiraCredentials {
	baseUrl: string;
	email: string;
	apiToken: string;
}

function resolveCredentials(
	config: ChannelTargetConfig | undefined,
	settings: PluginSettings | Readonly<Record<string, unknown>> | undefined
): JiraCredentials | undefined {
	const baseUrl = normalizeBaseUrl(config?.baseUrl) ?? normalizeBaseUrl(settings?.baseUrl);
	const emailRaw = config?.email ?? settings?.email;
	const tokenRaw = config?.apiToken ?? settings?.apiToken;
	if (
		baseUrl &&
		typeof emailRaw === 'string' &&
		emailRaw.length > 0 &&
		typeof tokenRaw === 'string' &&
		tokenRaw.length > 0
	) {
		return { baseUrl, email: emailRaw, apiToken: tokenRaw };
	}
	return undefined;
}

/**
 * Resolve the destination issue for an outbound comment. A per-send
 * `issueKey` overrides the connection's `defaultIssueKey`; the resolved
 * plugin `settings` default is the final fallback.
 */
function resolveIssueKey(config: ChannelTargetConfig, options: ConnectorCallOptions): string {
	const candidates = [
		config.issueKey,
		config.issueIdOrKey,
		config.defaultIssueKey,
		options.settings?.defaultIssueKey
	];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	throw new Error('jira-connector: an issue key is required (targetConfig.issueKey or defaultIssueKey)');
}

/**
 * JIRA connector (Wave 8) — first-party native connector.
 *
 * Outbound: posts comments on JIRA Cloud issues via `addComment` on the
 * `jira.js` client (API-token basic auth; the SDK renders a plain-text
 * comment into Atlassian Document Format for the v3 API).
 *
 * Vendor-SDK note: Atlassian publishes **no** maintained first-party
 * Node client for the Jira Cloud REST API — the Atlassian Labs
 * `@atlassian/jira` package stopped at `0.1.0` and has had no release
 * since 2018, and `@forge/api` only works inside a Forge app runtime.
 * `jira.js` is the actively maintained (released weekly), TypeScript-
 * native Jira Cloud client and is what this connector builds on.
 *
 * Event source: `pullEvents` sweeps issues updated since the watermark
 * with one bounded JQL query per page, normalized into
 * `IngestedEventEnvelope`s (`jira.issue` / `jira.comment`, the issue's
 * browse URL as `sourceUrl`). Unlike the sibling trackers, JIRA has no
 * "all comments" endpoint — comments only exist under an issue — so the
 * sweep requests the `comment` field alongside the issue and emits a
 * `jira.comment` envelope for every comment that itself changed inside
 * the window. That keeps a page at ONE API call instead of one per
 * issue, and an issue whose only change is a new comment is already in
 * the result set because commenting bumps `updated`.
 *
 * Work routing: the project is the container an Ever Works Work maps
 * onto, emitted as a `tracker-team` `workHint` keyed on the project key.
 *
 * The opt-in historical backfill (`backfillDays`, default 0 = off, max
 * 90) widens the FIRST pull's window only, with a page bound so
 * activation never becomes an unbounded crawl. Re-delivery across
 * overlapping windows is fine — the ingest pipeline dedupes on
 * `(source, sourceEventId)`.
 */
export class JiraConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'jira-connector';
	readonly name = 'JIRA Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [PLUGIN_CAPABILITIES.CONNECTOR, PLUGIN_CAPABILITIES.EVENT_SOURCE] as const;

	readonly providerName = 'jira';

	readonly connector: ConnectorMetadata = {
		direction: 'outbound',
		transport: 'poll',
		flags: {
			outboundMessage: true,
			outboundRecord: false,
			inbound: false,
			reply: false,
			pairing: false,
			richOutbound: false
		}
	};

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		required: ['baseUrl', 'email', 'apiToken'],
		properties: {
			baseUrl: {
				type: 'string',
				title: 'JIRA site base URL (https://your-site.atlassian.net)',
				'x-envVar': 'JIRA_BASE_URL'
			},
			email: {
				type: 'string',
				title: 'Atlassian account email (API-token basic auth)',
				'x-envVar': 'JIRA_EMAIL'
			},
			apiToken: {
				type: 'string',
				title: 'Atlassian API token',
				'x-secret': true,
				'x-envVar': 'JIRA_API_TOKEN'
			},
			projectKeys: {
				type: 'string',
				title: 'Project keys to ingest events from (comma-separated; all projects when empty)'
			},
			backfillDays: {
				type: 'number',
				title: 'Historical backfill window in days on first pull (0 = off, max 90)',
				default: 0,
				minimum: 0,
				maximum: 90
			},
			defaultIssueKey: {
				type: 'string',
				title: 'Default issue key for outbound comments (e.g. ENG-42)'
			}
		}
	};

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a client is created per call.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	/** Testable seam — specs stub this; production uses the real SDK. */
	protected createClient(credentials: JiraCredentials): JiraClientLike {
		const client = new Version3Client({
			host: credentials.baseUrl,
			authentication: { basic: { email: credentials.email, apiToken: credentials.apiToken } }
		});
		return {
			getCurrentUser: () => client.myself.getCurrentUser(),
			searchIssues: async (params) =>
				(await client.issueSearch.searchForIssuesUsingJqlEnhancedSearch({
					jql: params.jql,
					maxResults: params.maxResults,
					fields: params.fields,
					...(params.nextPageToken ? { nextPageToken: params.nextPageToken } : {})
				})) as JiraSearchPage,
			addComment: (params) =>
				client.issueComments.addComment({ issueIdOrKey: params.issueIdOrKey, comment: params.comment })
		};
	}

	async verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification> {
		const credentials = resolveCredentials(config, options.settings);
		if (!credentials) {
			return {
				valid: false,
				message: 'baseUrl (https site URL), email and apiToken are required'
			};
		}
		try {
			const user = await this.createClient(credentials).getCurrentUser();
			return {
				valid: true,
				details: {
					site: credentials.baseUrl,
					accountId: user?.accountId,
					displayName: user?.displayName
				}
			};
		} catch (err) {
			return { valid: false, message: `JIRA current-user lookup failed: ${jiraErrorMessage(err)}` };
		}
	}

	/** Outbound leg — create a comment on a JIRA issue. */
	async send(payload: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult> {
		const config = payload.target ?? options.target ?? {};
		const credentials = resolveCredentials(config, options.settings);
		if (!credentials) {
			throw new Error(
				'jira-connector: baseUrl (https site URL), email and apiToken are required to post a comment'
			);
		}
		const issueKey = resolveIssueKey(config, options);

		// Idempotency: scope the key to connectorId + issue + messageRef with
		// a NUL separator so components can't collide across tenants (mirrors
		// the sibling connectors — this plugin is a module-level singleton).
		const cacheKey = `${options.connectorId ?? ''}\0${issueKey}\0${payload.messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		let commentId: string | undefined;
		try {
			const res = await this.createClient(credentials).addComment({
				issueIdOrKey: issueKey,
				comment: payload.text
			});
			commentId = typeof res?.id === 'string' ? res.id : undefined;
		} catch (err) {
			throw new Error(`JIRA addComment failed: ${jiraErrorMessage(err)}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: commentId ?? `jira-${payload.messageRef}`,
			deliveredAt: new Date()
		};
		this.idempotencyCache.set(cacheKey, result);
		if (this.idempotencyCache.size > 500) {
			const firstKey = this.idempotencyCache.keys().next().value;
			if (firstKey) this.idempotencyCache.delete(firstKey);
		}
		return result;
	}

	// ── Event source (pull) ─────────────────────────────────────────────

	/**
	 * Pull one JQL page of issues updated since the effective watermark,
	 * normalized to `jira.issue` envelopes plus a `jira.comment` envelope
	 * per comment that changed inside the same window. The returned
	 * cursor resumes the sweep (API page token); no cursor means the
	 * sweep is done.
	 *
	 * First pull (epoch/absent watermark, no cursor): the window is
	 * `now - backfillDays` when the opt-in backfill is on, otherwise
	 * `now` — history stays untouched unless the user asked for it.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const credentials = resolveCredentials(undefined, input.settings);
		if (!credentials) {
			throw new EventSourceNotConfiguredError(
				'jira-connector: settings.baseUrl (https site URL), settings.email and settings.apiToken are required to pull events'
			);
		}

		const cursor = parsePullCursor(input.cursor);
		let pageToken: string | undefined;
		let since: string;
		let backfill: boolean;
		let pagesUsed: number;

		if (cursor) {
			pageToken = cursor.n;
			since = cursor.s;
			backfill = cursor.f === 1;
			pagesUsed = cursor.b ?? 0;
		} else {
			const sinceMs = Date.parse(input.since);
			const firstPull = !Number.isFinite(sinceMs) || sinceMs <= 0;
			const backfillDays = clampBackfillDays(input.settings?.backfillDays);
			if (firstPull) {
				const start = backfillDays > 0 ? Date.now() - backfillDays * 86400_000 : Date.now();
				since = new Date(start).toISOString();
				backfill = backfillDays > 0;
			} else {
				since = new Date(sinceMs).toISOString();
				backfill = false;
			}
			pageToken = undefined;
			pagesUsed = 0;
		}

		const client = this.createClient(credentials);
		const projectKeys = resolveProjectKeys(input.settings);
		const page = await client.searchIssues({
			jql: buildJql(since, projectKeys),
			maxResults: JIRA_PULL_PAGE_SIZE,
			fields: [...JIRA_ISSUE_FIELDS],
			...(pageToken ? { nextPageToken: pageToken } : {})
		});

		const events: IngestedEventEnvelope[] = [];
		for (const issue of page.issues ?? []) {
			const issueEnvelope = this.normalizeIssue(issue, since, credentials.baseUrl);
			if (issueEnvelope) events.push(issueEnvelope);
			for (const comment of issue.fields?.comment?.comments ?? []) {
				const commentEnvelope = this.normalizeComment(issue, comment, since, credentials.baseUrl);
				if (commentEnvelope) events.push(commentEnvelope);
			}
		}

		pagesUsed += 1;
		const pageBudgetExhausted = backfill && pagesUsed >= JIRA_BACKFILL_MAX_PAGES;
		const nextPageToken =
			typeof page.nextPageToken === 'string' && page.nextPageToken.length > 0 ? page.nextPageToken : undefined;

		const next: JiraPullCursor | undefined =
			nextPageToken && !pageBudgetExhausted
				? { n: nextPageToken, s: since, ...(backfill ? { f: 1 as const } : {}), b: pagesUsed }
				: undefined;

		return next ? { events, nextCursor: JSON.stringify(next) } : { events };
	}

	private normalizeIssue(issue: JiraIssueNode, since: string, baseUrl: string): IngestedEventEnvelope | null {
		if (!issue.id) return null;
		const fields = issue.fields ?? {};
		const updatedAt = toIso(fields.updated ?? fields.created);
		const createdAt = toIso(fields.created);
		const changeType = Date.parse(createdAt) >= Date.parse(since) ? 'created' : 'updated';
		const projectKey = fields.project?.key;
		const description = adfToText(fields.description);
		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${issue.id}:${updatedAt}`,
			kind: 'jira.issue',
			occurredAt: updatedAt,
			subject: {
				type: 'issue',
				externalId: issue.id,
				...(fields.summary ? { title: fields.summary } : {})
			},
			// Work routing: the project is the container an Ever Works Work
			// maps onto. Issues without a project stay user-scoped.
			...(projectKey
				? {
						workHint: {
							kind: 'tracker-team' as const,
							externalId: projectKey,
							...(fields.project?.name ? { label: fields.project.name } : {})
						}
					}
				: {}),
			...(issue.key ? { sourceUrl: `${baseUrl}/browse/${issue.key}` } : {}),
			payload: {
				issueId: issue.id,
				...(issue.key ? { issueKey: issue.key } : {}),
				...(projectKey ? { projectKey } : {}),
				...(fields.summary ? { summary: truncateText(fields.summary) } : {}),
				...(description ? { description: truncateText(description) } : {}),
				...(fields.status?.name ? { status: fields.status.name } : {}),
				...(fields.issuetype?.name ? { issueType: fields.issuetype.name } : {}),
				changeType,
				createdAt,
				updatedAt
			}
		};
	}

	/**
	 * Normalize one comment → envelope, or null when the comment did NOT
	 * change inside the sweep window. Commenting bumps the parent issue's
	 * `updated`, so an issue can arrive with a long comment history of
	 * which only the newest entry is actually news.
	 */
	private normalizeComment(
		issue: JiraIssueNode,
		comment: JiraCommentNode,
		since: string,
		baseUrl: string
	): IngestedEventEnvelope | null {
		if (!comment.id) return null;
		const updatedAt = toIso(comment.updated ?? comment.created);
		if (Date.parse(updatedAt) < Date.parse(since)) return null;

		const fields = issue.fields ?? {};
		const projectKey = fields.project?.key;
		const body = adfToText(comment.body);
		const sourceUrl = issue.key
			? `${baseUrl}/browse/${issue.key}?focusedCommentId=${encodeURIComponent(comment.id)}`
			: undefined;
		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${comment.id}:${updatedAt}`,
			kind: 'jira.comment',
			occurredAt: updatedAt,
			...(comment.author?.displayName
				? {
						actor: {
							name: comment.author.displayName,
							...(comment.author.accountId ? { externalId: comment.author.accountId } : {})
						}
					}
				: {}),
			subject: {
				type: 'issue',
				externalId: issue.id ?? 'unknown',
				...(fields.summary ? { title: fields.summary } : {})
			},
			// Same project-as-container routing as issues.
			...(projectKey
				? {
						workHint: {
							kind: 'tracker-team' as const,
							externalId: projectKey,
							...(fields.project?.name ? { label: fields.project.name } : {})
						}
					}
				: {}),
			...(sourceUrl ? { sourceUrl } : {}),
			payload: {
				commentId: comment.id,
				...(issue.id ? { issueId: issue.id } : {}),
				...(issue.key ? { issueKey: issue.key } : {}),
				...(projectKey ? { projectKey } : {}),
				...(body ? { body: truncateText(body) } : {}),
				createdAt: toIso(comment.created),
				updatedAt
			}
		};
	}
}

export const jiraConnectorPlugin = new JiraConnectorPlugin();
