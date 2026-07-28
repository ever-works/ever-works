import { randomUUID } from 'node:crypto';
import { LinearClient } from '@linear/sdk';
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
	EventSourceBackfillInput,
	EventSourceBackfillResult,
	PluginCategory,
	PluginSettings,
	JsonSchema
} from '@ever-works/plugin';
import { PLUGIN_CAPABILITIES, EventSourceNotConfiguredError, clampEventSourceBackfillDays } from '@ever-works/plugin';
import type { IngestedEventEnvelope } from '@ever-works/contracts';

/**
 * Payload text cap for ingested envelopes. Envelope payloads are
 * size-capped platform-side (32 KB serialized); issue descriptions and
 * comment bodies never need more than this to be useful in
 * Memory/Activities.
 */
export const LINEAR_EVENT_TEXT_MAX_CHARS = 4000;

/** Items requested per Linear page (issues and comments alike). */
export const LINEAR_PULL_PAGE_SIZE = 50;

/**
 * Historical backfill bound: at most this many pages per phase
 * (issues, then comments) during the opt-in first-pull backfill, so a
 * large workspace can never turn activation into an unbounded crawl.
 */
export const LINEAR_BACKFILL_MAX_PAGES = 10;

/**
 * Clamp the opt-in backfill window to the supported 0–90 day range.
 *
 * Delegates to the shared capability helper so the bound is stated once
 * for the whole connector fabric; the local export stays because it is
 * part of this plugin's published surface.
 */
export function clampBackfillDays(value: unknown): number {
	return clampEventSourceBackfillDays(value);
}

function truncateText(text: string): string {
	return text.length > LINEAR_EVENT_TEXT_MAX_CHARS ? text.slice(0, LINEAR_EVENT_TEXT_MAX_CHARS) : text;
}

/**
 * Team key out of an issue identifier (`ENG-123` → `ENG`).
 *
 * The issue/comment nodes this connector pulls carry the identifier but
 * not the team object, and resolving the team would cost one lazy fetch
 * per node. The identifier prefix IS the team key by Linear's own
 * construction, so it is both free and exact. Returns undefined for
 * anything that is not `<KEY>-<number>`.
 */
function teamKeyFromIdentifier(identifier: string | undefined): string | undefined {
	if (!identifier) return undefined;
	const match = /^([A-Za-z0-9]+)-\d+$/.exec(identifier.trim());
	return match ? match[1] : undefined;
}

/** Parse the team filter list: comma/space separated ids → array. */
function resolveTeamIds(settings: PluginSettings | undefined): string[] {
	const raw = settings?.teamIds;
	if (typeof raw === 'string' && raw.trim().length > 0) {
		return raw
			.split(/[\s,]+/)
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
	}
	return [];
}

/** Extract a readable message from a `@linear/sdk` error. */
function linearErrorMessage(err: unknown): string {
	const e = err as { message?: string; type?: string };
	return e.message ?? e.type ?? 'unknown error';
}

/** Date | ISO string | undefined → ISO 8601 (epoch on garbage). */
function toIso(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') {
		const ms = Date.parse(value);
		if (Number.isFinite(ms)) return new Date(ms).toISOString();
	}
	return new Date(0).toISOString();
}

/**
 * Opaque pull cursor. `p` is the sweep phase (issues → comments), `n`
 * the SDK page cursor, `s` the effective since-watermark the sweep was
 * started with (kept here so later pages of the same sweep use the
 * SAME window), `f` flags a first-pull backfill sweep and `b` counts
 * pages used in the current phase (backfill page bound). Malformed
 * input restarts the sweep — safe, the ingest pipeline dedupes on
 * `(source, sourceEventId)`.
 */
interface LinearPullCursor {
	p: 'issues' | 'comments';
	n?: string;
	s: string;
	f?: 1;
	b?: number;
}

function parsePullCursor(cursor: string | undefined): LinearPullCursor | undefined {
	if (!cursor) return undefined;
	try {
		const parsed = JSON.parse(cursor) as LinearPullCursor;
		if (parsed && (parsed.p === 'issues' || parsed.p === 'comments') && typeof parsed.s === 'string') {
			return parsed;
		}
	} catch {
		// fall through — treat as no cursor
	}
	return undefined;
}

/** Minimal scalar shape of an issue node we consume. */
interface LinearIssueNode {
	id?: string;
	identifier?: string;
	title?: string;
	description?: string;
	url?: string;
	createdAt?: Date | string;
	updatedAt?: Date | string;
}

/** Minimal scalar shape of a comment node we consume. */
interface LinearCommentNode {
	id?: string;
	body?: string;
	url?: string;
	createdAt?: Date | string;
	updatedAt?: Date | string;
	/** Lazy parent-issue fetch (awaited per node, best-effort). */
	issue?: Promise<LinearIssueNode | undefined> | LinearIssueNode;
}

interface LinearConnectionPage<T> {
	nodes?: T[];
	pageInfo?: { hasNextPage?: boolean; endCursor?: string };
}

/** The subset of the `LinearClient` surface this plugin calls. */
interface LinearClientLike {
	viewer: Promise<{ id?: string; name?: string; email?: string }>;
	issues(args: Record<string, unknown>): Promise<LinearConnectionPage<LinearIssueNode>>;
	comments(args: Record<string, unknown>): Promise<LinearConnectionPage<LinearCommentNode>>;
	createComment(input: {
		issueId: string;
		body: string;
	}): Promise<{ success?: boolean; comment?: Promise<{ id?: string } | undefined> | { id?: string } }>;
}

function resolveApiKey(config: ChannelTargetConfig, options: ConnectorCallOptions): string | undefined {
	const candidates = [config.apiKey, options.settings?.apiKey];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	return undefined;
}

/**
 * Resolve the destination issue id for an outbound comment. A per-send
 * `issueId` overrides the connection's `defaultIssueId`; the resolved
 * plugin `settings` default is the final fallback.
 */
function resolveIssueId(config: ChannelTargetConfig, options: ConnectorCallOptions): string {
	const candidates = [config.issueId, config.defaultIssueId, options.settings?.defaultIssueId];
	for (const c of candidates) {
		if (typeof c === 'string' && c.length > 0) return c;
	}
	throw new Error('linear-connector: an issue id is required (targetConfig.issueId or defaultIssueId)');
}

/**
 * Linear connector (Wave 8) — first-party native connector.
 *
 * Outbound: posts comments on Linear issues via `createComment` on the
 * official `@linear/sdk` (API-key auth; the SDK pins the GraphQL host,
 * so there is no SSRF surface).
 *
 * Event source: `pullEvents` sweeps issues (created/updated) then
 * comments since the watermark, normalized into
 * `IngestedEventEnvelope`s (`linear.issue` / `linear.comment`, issue
 * url as `sourceUrl`) for the platform's event-ingest spine. The
 * opt-in historical backfill (`backfillDays`, default 0 = off, max 90)
 * widens the FIRST pull's window only, with a per-phase page bound so
 * activation never becomes an unbounded crawl. Re-delivery across
 * overlapping windows is fine — the ingest pipeline dedupes on
 * `(source, sourceEventId)`.
 */
export class LinearConnectorPlugin implements IConnectorPlugin, IEventSourcePlugin {
	readonly id = 'linear-connector';
	readonly name = 'Linear Connector';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'connector';
	readonly capabilities = [
		PLUGIN_CAPABILITIES.CONNECTOR,
		PLUGIN_CAPABILITIES.CONNECTOR_LINEAR,
		PLUGIN_CAPABILITIES.EVENT_SOURCE
	] as const;

	readonly providerName = 'linear';

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
		required: ['apiKey'],
		properties: {
			apiKey: {
				type: 'string',
				title: 'Linear API key (lin_api_…)',
				'x-secret': true,
				'x-envVar': 'LINEAR_API_KEY'
			},
			teamIds: {
				type: 'string',
				title: 'Team ids to ingest events from (comma-separated; all teams when empty)'
			},
			backfillDays: {
				type: 'number',
				title: 'Historical backfill window in days on first pull (0 = off, max 90)',
				default: 0,
				minimum: 0,
				maximum: 90
			},
			defaultIssueId: {
				type: 'string',
				title: 'Default issue id for outbound comments'
			}
		}
	};

	private readonly idempotencyCache = new Map<string, ChannelSendResult>();

	async onLoad(): Promise<void> {
		// No-op — no warm-up resources; a LinearClient is created per call.
	}

	async onUnload(): Promise<void> {
		this.idempotencyCache.clear();
	}

	/** Testable seam — specs stub this; production uses the real SDK. */
	protected createClient(apiKey: string): LinearClientLike {
		return new LinearClient({ apiKey }) as unknown as LinearClientLike;
	}

	async verifyConnection(config: ChannelTargetConfig, options: ConnectorCallOptions): Promise<ChannelVerification> {
		const apiKey = resolveApiKey(config, options);
		if (!apiKey) {
			return { valid: false, message: 'apiKey is required' };
		}
		try {
			const viewer = await this.createClient(apiKey).viewer;
			return {
				valid: true,
				details: {
					viewerId: viewer?.id,
					viewerName: viewer?.name,
					...(viewer?.email ? { email: viewer.email } : {})
				}
			};
		} catch (err) {
			return { valid: false, message: `Linear viewer lookup failed: ${linearErrorMessage(err)}` };
		}
	}

	/** Outbound leg — create a comment on a Linear issue. */
	async send(payload: ChannelSendInput, options: ConnectorCallOptions): Promise<ChannelSendResult> {
		const config = payload.target ?? options.target ?? {};
		const apiKey = resolveApiKey(config, options);
		if (!apiKey) {
			throw new Error('linear-connector: an API key is required (targetConfig.apiKey or settings.apiKey)');
		}
		const issueId = resolveIssueId(config, options);

		// Idempotency: scope the key to connectorId + issue + messageRef with a
		// NUL separator so components can't collide across tenants (mirrors the
		// slack-connector hardening — this plugin is a module-level singleton).
		const cacheKey = `${options.connectorId ?? ''}\0${issueId}\0${payload.messageRef}`;
		const cached = this.idempotencyCache.get(cacheKey);
		if (cached) return cached;

		let commentId: string | undefined;
		try {
			const res = await this.createClient(apiKey).createComment({ issueId, body: payload.text });
			const comment = res.comment ? await res.comment : undefined;
			commentId = typeof comment?.id === 'string' ? comment.id : undefined;
		} catch (err) {
			throw new Error(`Linear createComment failed: ${linearErrorMessage(err)}`);
		}

		const result: ChannelSendResult = {
			provider: this.id,
			providerMessageId: commentId ?? `linear-${payload.messageRef}`,
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
	 * Pull one page of the current sweep phase (issues → comments)
	 * since the effective watermark, normalized to envelopes. The
	 * returned cursor resumes the same phase (SDK page cursor) or
	 * advances to the next; no cursor means the sweep is done.
	 *
	 * First pull (epoch/absent watermark, no cursor): the window is
	 * `now - backfillDays` when the opt-in backfill is on, otherwise
	 * `now` — history stays untouched unless the user asked for it.
	 */
	async pullEvents(input: EventSourcePullInput): Promise<EventSourcePullResult> {
		const apiKey = input.settings?.apiKey;
		if (typeof apiKey !== 'string' || apiKey.length === 0) {
			throw new EventSourceNotConfiguredError('linear-connector: settings.apiKey is required to pull events');
		}

		const cursor = parsePullCursor(input.cursor);
		let phase: 'issues' | 'comments';
		let after: string | undefined;
		let since: string;
		let backfill: boolean;
		let pagesUsed: number;

		if (cursor) {
			phase = cursor.p;
			after = cursor.n;
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
			phase = 'issues';
			after = undefined;
			pagesUsed = 0;
		}

		const client = this.createClient(apiKey);
		const teamIds = resolveTeamIds(input.settings);
		const events: IngestedEventEnvelope[] = [];
		let hasNextPage = false;
		let endCursor: string | undefined;

		if (phase === 'issues') {
			const page = await client.issues({
				first: LINEAR_PULL_PAGE_SIZE,
				...(after ? { after } : {}),
				filter: {
					updatedAt: { gte: new Date(since) },
					...(teamIds.length > 0 ? { team: { id: { in: teamIds } } } : {})
				}
			});
			for (const issue of page.nodes ?? []) {
				const envelope = this.normalizeIssue(issue, since);
				if (envelope) events.push(envelope);
			}
			hasNextPage = page.pageInfo?.hasNextPage === true;
			endCursor = page.pageInfo?.endCursor;
		} else {
			const page = await client.comments({
				first: LINEAR_PULL_PAGE_SIZE,
				...(after ? { after } : {}),
				filter: { updatedAt: { gte: new Date(since) } }
			});
			for (const comment of page.nodes ?? []) {
				const envelope = await this.normalizeComment(comment);
				if (envelope) events.push(envelope);
			}
			hasNextPage = page.pageInfo?.hasNextPage === true;
			endCursor = page.pageInfo?.endCursor;
		}

		pagesUsed += 1;
		const pageBudgetExhausted = backfill && pagesUsed >= LINEAR_BACKFILL_MAX_PAGES;

		let next: LinearPullCursor | undefined;
		if (hasNextPage && endCursor && !pageBudgetExhausted) {
			next = { p: phase, n: endCursor, s: since, ...(backfill ? { f: 1 as const } : {}), b: pagesUsed };
		} else if (phase === 'issues') {
			// Advance to the comments phase (page counter resets per phase).
			next = { p: 'comments', s: since, ...(backfill ? { f: 1 as const } : {}), b: 0 };
		}

		return next ? { events, nextCursor: JSON.stringify(next) } : { events };
	}

	/**
	 * Bounded HISTORICAL sweep from an explicit `since` — the
	 * capability's opt-in `backfill()` method.
	 *
	 * Before this method existed, history was reachable only as a side
	 * effect of the FIRST pull (`settings.backfillDays` widening the
	 * initial window), so a user who activated the connector without the
	 * setting could never go back and fetch it. `backfill()` runs the
	 * same two-phase sweep (issues → comments) out-of-band on a
	 * caller-chosen window, as many times as wanted — re-delivery is free
	 * because the ingest pipeline dedupes on `(source, sourceEventId)`.
	 *
	 * `until` is accepted for contract symmetry but NOT applied: the SDK
	 * filter bounds only the near end (`updatedAt >= since`). An
	 * over-wide window costs duplicate deliveries, which the pipeline
	 * drops — never wrong data.
	 *
	 * The per-phase page bound (`LINEAR_BACKFILL_MAX_PAGES`) applies here
	 * too: one call fetches ONE page and hands back a cursor, so a large
	 * workspace can never turn a backfill into an unbounded crawl.
	 */
	async backfill(input: EventSourceBackfillInput): Promise<EventSourceBackfillResult> {
		const sinceMs = Date.parse(input.since);
		if (!Number.isFinite(sinceMs)) {
			throw new EventSourceNotConfiguredError(
				`linear-connector: backfill requires a valid ISO 8601 "since" (received ${JSON.stringify(input.since)})`
			);
		}

		// Resume the caller's cursor, or open the sweep on the issues
		// phase. `f: 1` marks it a backfill sweep so the page bound
		// engages.
		const cursor =
			input.cursor ??
			JSON.stringify({
				p: 'issues',
				s: new Date(sinceMs).toISOString(),
				f: 1 as const,
				b: 0
			} satisfies LinearPullCursor);

		const page = await this.pullEvents({
			since: input.since,
			cursor,
			...(input.settings ? { settings: input.settings } : {})
		});

		return page.nextCursor
			? { events: page.events, nextCursor: page.nextCursor }
			: { events: page.events, complete: true };
	}

	private normalizeIssue(issue: LinearIssueNode, since: string): IngestedEventEnvelope | null {
		if (!issue.id) return null;
		const updatedAt = toIso(issue.updatedAt ?? issue.createdAt);
		const createdAt = toIso(issue.createdAt);
		const changeType = Date.parse(createdAt) >= Date.parse(since) ? 'created' : 'updated';
		const teamKey = teamKeyFromIdentifier(issue.identifier);
		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${issue.id}:${updatedAt}`,
			kind: 'linear.issue',
			occurredAt: updatedAt,
			subject: {
				type: 'issue',
				externalId: issue.id,
				...(issue.title ? { title: issue.title } : {})
			},
			// Work routing: the team is the container an Ever Works Work
			// maps onto. Issues with an unparseable identifier carry no
			// hint and stay user-scoped.
			...(teamKey ? { workHint: { kind: 'tracker-team' as const, externalId: teamKey } } : {}),
			...(issue.url ? { sourceUrl: issue.url } : {}),
			payload: {
				issueId: issue.id,
				...(issue.identifier ? { identifier: issue.identifier } : {}),
				...(issue.title ? { title: truncateText(issue.title) } : {}),
				...(issue.description ? { description: truncateText(issue.description) } : {}),
				changeType,
				createdAt,
				updatedAt
			}
		};
	}

	/**
	 * Normalize one comment → envelope. The parent issue is a lazy SDK
	 * fetch — awaited best-effort for the subject/sourceUrl; a failure
	 * degrades to the comment's own permalink.
	 */
	private async normalizeComment(comment: LinearCommentNode): Promise<IngestedEventEnvelope | null> {
		if (!comment.id) return null;
		const updatedAt = toIso(comment.updatedAt ?? comment.createdAt);
		let issue: LinearIssueNode | undefined;
		try {
			issue = comment.issue ? await comment.issue : undefined;
		} catch {
			issue = undefined;
		}
		const sourceUrl = comment.url ?? issue?.url;
		const teamKey = teamKeyFromIdentifier(issue?.identifier);
		return {
			id: randomUUID(),
			source: this.id,
			sourceEventId: `${comment.id}:${updatedAt}`,
			kind: 'linear.comment',
			occurredAt: updatedAt,
			subject: {
				type: 'issue',
				externalId: issue?.id ?? 'unknown',
				...(issue?.title ? { title: issue.title } : {})
			},
			// Same team-as-container routing as issues; the parent-issue
			// fetch is best-effort, so a failed one simply means no hint.
			...(teamKey ? { workHint: { kind: 'tracker-team' as const, externalId: teamKey } } : {}),
			...(sourceUrl ? { sourceUrl } : {}),
			payload: {
				commentId: comment.id,
				...(issue?.id ? { issueId: issue.id } : {}),
				...(issue?.identifier ? { issueIdentifier: issue.identifier } : {}),
				...(comment.body ? { body: truncateText(comment.body) } : {}),
				createdAt: toIso(comment.createdAt),
				updatedAt
			}
		};
	}
}

export const linearConnectorPlugin = new LinearConnectorPlugin();
