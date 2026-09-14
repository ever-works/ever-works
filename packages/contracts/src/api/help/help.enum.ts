/**
 * Help centre (AW-25) — closed vocabularies and the structured article grammar.
 *
 * The in-product manual renders pages of the documentation site (`docs/`) that
 * ship with the build. Nothing here is persisted: a build-time generator turns
 * those Markdown pages into the structured blocks below, and the web app renders
 * the blocks without ever injecting raw markup (spec FR-28). These tuples and
 * types are the one definition the generator, the renderer and any later API
 * surface agree on.
 */

/**
 * The manual's sections, in reading order (spec FR-4). A closed set of six —
 * adding a seventh is a spec change, not an authoring decision.
 */
export const HELP_SECTIONS = [
	'start-here',
	'running-the-loop',
	'your-agents',
	'setup-and-connections',
	'money-and-limits',
	'when-something-goes-wrong'
] as const;
export type HelpSection = (typeof HELP_SECTIONS)[number];

/**
 * Every block kind an article body may contain (spec FR-27). Closed — the
 * renderer switches over this set without a default branch, so a new kind is a
 * compile error until it is rendered. `table` is part of the set because the
 * documentation pages the manual reuses present reference material as tables.
 */
export const HELP_BLOCK_KINDS = [
	'paragraph',
	'heading',
	'orderedList',
	'unorderedList',
	'note',
	'shortcut',
	'code',
	'link',
	'table'
] as const;
export type HelpBlockKind = (typeof HELP_BLOCK_KINDS)[number];

/** What a link may point at (spec FR-27a). Closed. */
export const HELP_LINK_TARGET_TYPES = ['article', 'screen', 'external'] as const;
export type HelpLinkTargetType = (typeof HELP_LINK_TARGET_TYPES)[number];

/** Visual tone of a callout block. Closed. */
export const HELP_NOTE_TONES = ['note', 'tip', 'info', 'warning', 'danger'] as const;
export type HelpNoteTone = (typeof HELP_NOTE_TONES)[number];

/**
 * Build-time limits (spec FR-3). Where the manual reuses an existing
 * documentation page, the body and heading ceilings are sized for those pages
 * rather than for short purpose-written articles.
 */
export const HELP_LIMITS = {
	maxArticles: 200,
	titleChars: 70,
	summaryChars: 200,
	bodyChars: 60_000,
	maxHeadings: 80,
	headingIdMinChars: 2,
	headingIdMaxChars: 96,
	maxKeywords: 12,
	keywordChars: 32,
	maxDocuments: 8,
	maxRelated: 5,
	linkLabelChars: 80,
	externalHrefChars: 2048
} as const;

/** Article identifier: lowercase letters, digits and hyphens, 3–64 characters (spec FR-3). */
export const HELP_ARTICLE_ID_PATTERN = /^[a-z0-9-]{3,64}$/;

export type HelpLinkTarget =
	/** Another article, optionally at a heading. Resolved like a help link (spec FR-22). */
	| { type: 'article'; articleId: string; headingId: string | null }
	/** A KEY of the web app's route map — never a literal path (spec FR-5.2). */
	| { type: 'screen'; routeKey: string }
	/** Absolute `https:` URL with no embedded credentials (spec FR-27a). */
	| { type: 'external'; href: string };

/** Inline content inside a paragraph, list item, heading or table cell. */
export type HelpInline =
	| { type: 'text'; text: string }
	| { type: 'strong'; children: HelpInline[] }
	| { type: 'emphasis'; children: HelpInline[] }
	| { type: 'code'; text: string }
	| { type: 'link'; children: HelpInline[]; target: HelpLinkTarget };

export interface HelpListItem {
	content: HelpInline[];
	/** Nested blocks — a sub-list, a code sample or a callout inside the item. */
	children: HelpBlock[];
}

export interface HelpLinkBlock {
	kind: 'link';
	/** Plain text, 1–80 characters, no inline markup. */
	label: string;
	target: HelpLinkTarget;
}

export type HelpBlock =
	| { kind: 'paragraph'; content: HelpInline[] }
	| { kind: 'heading'; level: 2 | 3 | 4; id: string; content: HelpInline[] }
	| { kind: 'orderedList'; items: HelpListItem[] }
	| { kind: 'unorderedList'; items: HelpListItem[] }
	| { kind: 'note'; tone: HelpNoteTone; title: string | null; blocks: HelpBlock[] }
	| { kind: 'shortcut'; keys: string[]; label: string }
	| { kind: 'code'; language: string | null; text: string }
	| HelpLinkBlock
	| { kind: 'table'; header: HelpInline[][]; rows: HelpInline[][][] };

/** The body file the generator emits for one article. */
export interface HelpArticleBody {
	/** Format version of this file; bumped only on an incompatible grammar change. */
	version: 1;
	id: string;
	blocks: HelpBlock[];
}

/** Narrowing guard for a section read from an untrusted source. */
export function isHelpSection(value: unknown): value is HelpSection {
	return typeof value === 'string' && (HELP_SECTIONS as readonly string[]).includes(value);
}

/** Narrowing guard for an article identifier read from an untrusted source (a URL segment). */
export function isHelpArticleId(value: unknown): value is string {
	return typeof value === 'string' && HELP_ARTICLE_ID_PATTERN.test(value);
}
