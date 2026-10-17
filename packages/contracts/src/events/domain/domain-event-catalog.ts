/**
 * Domain event catalog v1 (EW-P1-1) — every event type Ever Works records in
 * its `domain_events` outbox, as published in the integration contract
 * (`docs/specs/features/integrations-api-v1/contract/event-catalog.v1.json`).
 *
 * This list and the JSON catalog must name the same types in the same order;
 * `domain-event-contract.spec.ts` in `packages/agent` fails when they drift.
 * Adding a type is additive (catalog v1 grows); renaming or removing one is a
 * breaking change that needs catalog v2.
 *
 * - `phase` is the integration plan phase that starts recording the type
 *   (`P1` types are recorded today; later ones are reserved names).
 * - `child` marks an event about an edge or child row: the envelope's
 *   `aggregate` is the PARENT with its new version and `data` is the child.
 * - `optIn` events are excluded from the integration feed and webhooks unless
 *   a consumer names them exactly.
 */

/** Aggregate types an event can be about. */
export const DOMAIN_EVENT_AGGREGATE_TYPES = [
	'organization',
	'agent',
	'team',
	'work',
	'mission',
	'goal',
	'idea',
	'task',
	'inbox_item',
	'kb_document',
	'kb_folder',
	'email_message'
] as const;

export type DomainEventAggregateType = (typeof DOMAIN_EVENT_AGGREGATE_TYPES)[number];

/** Integration plan phase that starts recording a type. */
export type DomainEventPhase = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

/** One row of the catalog. */
export interface DomainEventCatalogEntry {
	readonly type: string;
	readonly domain: string;
	readonly aggregateType: DomainEventAggregateType;
	readonly phase: DomainEventPhase;
	readonly child?: string;
	readonly optIn?: boolean;
}

/** Version of the catalog (bumped only by a breaking change). */
export const DOMAIN_EVENT_CATALOG_VERSION = 1;

/** Payload schema version every v1 type is recorded with. */
export const DOMAIN_EVENT_PAYLOAD_VERSION = 1;

export const DOMAIN_EVENT_CATALOG = [
	// EW-P2-6 — `org:write` (and the app) create Organizations.
	{ type: 'organization.created', domain: 'organization', aggregateType: 'organization', phase: 'P2' },
	{ type: 'organization.updated', domain: 'organization', aggregateType: 'organization', phase: 'P1' },
	{
		type: 'organization.member.added',
		domain: 'organization',
		aggregateType: 'organization',
		phase: 'P1',
		child: 'member'
	},
	{
		type: 'organization.member.updated',
		domain: 'organization',
		aggregateType: 'organization',
		phase: 'P1',
		child: 'member'
	},
	{
		type: 'organization.member.removed',
		domain: 'organization',
		aggregateType: 'organization',
		phase: 'P1',
		child: 'member'
	},
	{ type: 'agent.created', domain: 'agents', aggregateType: 'agent', phase: 'P1' },
	{ type: 'agent.updated', domain: 'agents', aggregateType: 'agent', phase: 'P1' },
	{ type: 'agent.status_changed', domain: 'agents', aggregateType: 'agent', phase: 'P1' },
	{ type: 'agent.archived', domain: 'agents', aggregateType: 'agent', phase: 'P1' },
	{ type: 'agent.deleted', domain: 'agents', aggregateType: 'agent', phase: 'P1' },
	{ type: 'team.created', domain: 'teams', aggregateType: 'team', phase: 'P1' },
	{ type: 'team.updated', domain: 'teams', aggregateType: 'team', phase: 'P1' },
	{ type: 'team.deleted', domain: 'teams', aggregateType: 'team', phase: 'P1' },
	{ type: 'team.member.added', domain: 'teams', aggregateType: 'team', phase: 'P1', child: 'member' },
	{ type: 'team.member.updated', domain: 'teams', aggregateType: 'team', phase: 'P1', child: 'member' },
	{ type: 'team.member.removed', domain: 'teams', aggregateType: 'team', phase: 'P1', child: 'member' },
	{ type: 'team.resource.added', domain: 'teams', aggregateType: 'team', phase: 'P1', child: 'resource' },
	{ type: 'team.resource.removed', domain: 'teams', aggregateType: 'team', phase: 'P1', child: 'resource' },
	{ type: 'work.created', domain: 'works', aggregateType: 'work', phase: 'P1' },
	{ type: 'work.updated', domain: 'works', aggregateType: 'work', phase: 'P1' },
	{ type: 'work.archived', domain: 'works', aggregateType: 'work', phase: 'P1' },
	{ type: 'work.deleted', domain: 'works', aggregateType: 'work', phase: 'P1' },
	{ type: 'work.member.added', domain: 'works', aggregateType: 'work', phase: 'P1', child: 'member' },
	{ type: 'work.member.updated', domain: 'works', aggregateType: 'work', phase: 'P1', child: 'member' },
	{ type: 'work.member.removed', domain: 'works', aggregateType: 'work', phase: 'P1', child: 'member' },
	{ type: 'mission.created', domain: 'missions', aggregateType: 'mission', phase: 'P2' },
	{ type: 'mission.updated', domain: 'missions', aggregateType: 'mission', phase: 'P2' },
	{ type: 'mission.status_changed', domain: 'missions', aggregateType: 'mission', phase: 'P2' },
	{ type: 'mission.deleted', domain: 'missions', aggregateType: 'mission', phase: 'P2' },
	{ type: 'mission.goal.linked', domain: 'missions', aggregateType: 'mission', phase: 'P2', child: 'goal' },
	{ type: 'mission.goal.unlinked', domain: 'missions', aggregateType: 'mission', phase: 'P2', child: 'goal' },
	{ type: 'mission.work.linked', domain: 'missions', aggregateType: 'mission', phase: 'P2', child: 'work' },
	{ type: 'mission.work.unlinked', domain: 'missions', aggregateType: 'mission', phase: 'P2', child: 'work' },
	{ type: 'goal.created', domain: 'goals', aggregateType: 'goal', phase: 'P2' },
	{ type: 'goal.updated', domain: 'goals', aggregateType: 'goal', phase: 'P2' },
	{ type: 'goal.status_changed', domain: 'goals', aggregateType: 'goal', phase: 'P2' },
	{ type: 'goal.archived', domain: 'goals', aggregateType: 'goal', phase: 'P2' },
	{ type: 'goal.unarchived', domain: 'goals', aggregateType: 'goal', phase: 'P2' },
	{ type: 'goal.deleted', domain: 'goals', aggregateType: 'goal', phase: 'P2' },
	{ type: 'goal.progress_changed', domain: 'goals', aggregateType: 'goal', phase: 'P2' },
	{ type: 'idea.created', domain: 'ideas', aggregateType: 'idea', phase: 'P2' },
	{ type: 'idea.updated', domain: 'ideas', aggregateType: 'idea', phase: 'P2' },
	{ type: 'idea.status_changed', domain: 'ideas', aggregateType: 'idea', phase: 'P2' },
	{ type: 'idea.deleted', domain: 'ideas', aggregateType: 'idea', phase: 'P2' },
	{ type: 'task.created', domain: 'tasks', aggregateType: 'task', phase: 'P1' },
	{ type: 'task.updated', domain: 'tasks', aggregateType: 'task', phase: 'P1' },
	{ type: 'task.transitioned', domain: 'tasks', aggregateType: 'task', phase: 'P1' },
	{ type: 'task.deleted', domain: 'tasks', aggregateType: 'task', phase: 'P1' },
	{ type: 'task.assignee.added', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'assignee' },
	{ type: 'task.assignee.removed', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'assignee' },
	{ type: 'task.watcher.added', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'watcher' },
	{ type: 'task.watcher.removed', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'watcher' },
	{ type: 'task.block.added', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'block' },
	{ type: 'task.block.removed', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'block' },
	{ type: 'task.relation.added', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'relation' },
	{ type: 'task.relation.removed', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'relation' },
	{ type: 'task.comment.created', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'comment' },
	{ type: 'task.comment.updated', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'comment' },
	{ type: 'task.comment.deleted', domain: 'tasks', aggregateType: 'task', phase: 'P1', child: 'comment' },
	{ type: 'task.attachment.added', domain: 'tasks', aggregateType: 'task', phase: 'P3', child: 'attachment' },
	{ type: 'task.attachment.removed', domain: 'tasks', aggregateType: 'task', phase: 'P3', child: 'attachment' },
	{ type: 'task.runtime_updated', domain: 'tasks', aggregateType: 'task', phase: 'P1', optIn: true },
	{ type: 'inbox.item.created', domain: 'inbox', aggregateType: 'inbox_item', phase: 'P3' },
	{ type: 'inbox.item.answered', domain: 'inbox', aggregateType: 'inbox_item', phase: 'P3' },
	{ type: 'inbox.item.state_changed', domain: 'inbox', aggregateType: 'inbox_item', phase: 'P3' },
	{ type: 'inbox.item.deleted', domain: 'inbox', aggregateType: 'inbox_item', phase: 'P3' },
	{ type: 'kb.document.created', domain: 'kb', aggregateType: 'kb_document', phase: 'P3' },
	{ type: 'kb.document.updated', domain: 'kb', aggregateType: 'kb_document', phase: 'P3' },
	{ type: 'kb.document.moved', domain: 'kb', aggregateType: 'kb_document', phase: 'P3' },
	{ type: 'kb.document.archived', domain: 'kb', aggregateType: 'kb_document', phase: 'P3' },
	{ type: 'kb.document.unarchived', domain: 'kb', aggregateType: 'kb_document', phase: 'P3' },
	{ type: 'kb.document.deleted', domain: 'kb', aggregateType: 'kb_document', phase: 'P3' },
	{ type: 'kb.document.review_changed', domain: 'kb', aggregateType: 'kb_document', phase: 'P3' },
	{ type: 'kb.folder.created', domain: 'kb', aggregateType: 'kb_folder', phase: 'P3' },
	{ type: 'kb.folder.updated', domain: 'kb', aggregateType: 'kb_folder', phase: 'P3' },
	{ type: 'kb.folder.deleted', domain: 'kb', aggregateType: 'kb_folder', phase: 'P3' },
	{ type: 'email.message.received', domain: 'email', aggregateType: 'email_message', phase: 'P4' },
	{ type: 'email.message.sent', domain: 'email', aggregateType: 'email_message', phase: 'P4' },
	{ type: 'email.message.status_changed', domain: 'email', aggregateType: 'email_message', phase: 'P4' },
	{ type: 'task.visibility_changed', domain: 'visibility', aggregateType: 'task', phase: 'P1' },
	{ type: 'agent.visibility_changed', domain: 'visibility', aggregateType: 'agent', phase: 'P1' },
	{ type: 'goal.visibility_changed', domain: 'visibility', aggregateType: 'goal', phase: 'P2' },
	{ type: 'mission.visibility_changed', domain: 'visibility', aggregateType: 'mission', phase: 'P2' },
	{ type: 'idea.visibility_changed', domain: 'visibility', aggregateType: 'idea', phase: 'P2' }
] as const satisfies readonly DomainEventCatalogEntry[];

/** Every catalog type, as a closed union. */
export type DomainEventType = (typeof DOMAIN_EVENT_CATALOG)[number]['type'];

/** Every catalog type, in catalog order. */
export const DOMAIN_EVENT_TYPES: readonly DomainEventType[] = DOMAIN_EVENT_CATALOG.map((entry) => entry.type);

const CATALOG_BY_TYPE: ReadonlyMap<string, DomainEventCatalogEntry> = new Map(
	DOMAIN_EVENT_CATALOG.map((entry) => [entry.type, entry])
);

/** `true` when `type` is a catalog v1 type. */
export function isDomainEventType(type: string): type is DomainEventType {
	return CATALOG_BY_TYPE.has(type);
}

/** The catalog row of a type, or `undefined` for an unknown type. */
export function getDomainEventCatalogEntry(type: string): DomainEventCatalogEntry | undefined {
	return CATALOG_BY_TYPE.get(type);
}

/**
 * Whether `type` matches one subscription pattern.
 *
 * - `*` matches every type.
 * - `<prefix>.*` matches every type that starts with `<prefix>.` (so `task.*`
 *   matches `task.updated` and `task.comment.created`, never `taskforce.x`).
 * - Anything else is an exact match.
 *
 * Opt-in types (`task.runtime_updated`) are matched ONLY by an exact pattern,
 * never by `*` or a wildcard, so a broad subscription never receives the
 * machine-only noise they exist to keep out of the feed.
 */
export function matchesDomainEventPattern(type: string, pattern: string): boolean {
	if (pattern === type) return true;
	if (CATALOG_BY_TYPE.get(type)?.optIn) return false;
	if (pattern === '*') return true;
	if (pattern.endsWith('.*')) return type.startsWith(pattern.slice(0, -1));
	return false;
}

/** Whether `type` matches any of `patterns` (see {@link matchesDomainEventPattern}). */
export function matchesAnyDomainEventPattern(type: string, patterns: readonly string[]): boolean {
	return patterns.some((pattern) => matchesDomainEventPattern(type, pattern));
}
