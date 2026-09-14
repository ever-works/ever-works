import type { ChangelogCategory, ChangelogKind } from './changelog.enum.js';

/**
 * What's new (AW-14) — wire contracts for `GET/POST /api/changelog/*`.
 *
 * Pure types, no decorators, so the API, the web app and any external client
 * can import them. Additive-only (these ship in a public package).
 */

/** An in-product call-to-action: a button label and the app path it opens. */
export interface ChangelogCtaDto {
	label: string;
	/** Always an in-product path beginning with exactly one `/` (spec FR-39). */
	href: string;
}

/**
 * One product changelog entry as a reader sees it.
 *
 * Title and body are authored in English and are content, not interface
 * chrome — they are never passed through the translation layer (spec FR-11).
 */
export interface ChangelogEntryDto {
	/** Stable slug; the permalink (spec FR-6). */
	slug: string;
	/** ≤ 80 characters (spec FR-5). */
	title: string;
	/** Plain text, ≤ 600 characters, ≤ 3 paragraphs, line breaks preserved (spec FR-5). */
	body: string;
	category: ChangelogCategory;
	kind: ChangelogKind;
	/** ISO-8601 publish timestamp. Future-dated entries are never returned (spec FR-7). */
	publishedAt: string;
	/** At most one entry is pinned; it sorts first (spec FR-8). */
	pinned: boolean;
	/** `null` when the entry has no call-to-action OR its target is not a safe in-product path (spec FR-40). */
	cta: ChangelogCtaDto | null;
	/** Read for this person — explicitly, or because it predates their account (spec FR-14). */
	isRead: boolean;
}

/** `GET /api/changelog` */
export interface ChangelogListResponseDto {
	entries: ChangelogEntryDto[];
	/** Slug of the last returned entry when another page exists, otherwise `null`. */
	nextCursor: string | null;
	/** Visible entries in this build, ignoring any category filter. */
	total: number;
	/** Always the UNFILTERED unread count — a category filter never changes it (spec FR-38). */
	unreadCount: number;
	/** Categories that have at least one visible entry; the others render as disabled chips (spec FR-37). */
	categoriesWithEntries: ChangelogCategory[];
}

/** `GET /api/changelog/unread-count` */
export interface ChangelogUnreadCountResponseDto {
	count: number;
}

/** `POST /api/changelog/read` and `POST /api/changelog/read-all` */
export interface ChangelogMarkReadResponseDto {
	/** The reader's fresh unread count after the write (spec FR-18, FR-19). */
	unreadCount: number;
}

/** `POST /api/changelog/read` request body. */
export interface ChangelogMarkReadRequestDto {
	/** 1–25 entry slugs (spec FR-17). Slugs this build does not know are ignored. */
	slugs: string[];
}

/**
 * The authoring shape a changelog content source yields — what a person (or
 * a later non-file source) writes, before the API validates it and resolves
 * per-reader read state.
 *
 * Kept in contracts rather than inside the API so a content source that
 * lives outside `apps/api` can produce records of exactly this shape.
 */
export interface ChangelogSourceEntry {
	readonly slug: string;
	readonly title: string;
	readonly body: string;
	readonly category: ChangelogCategory;
	readonly kind: ChangelogKind;
	/** ISO-8601 date or date-time. */
	readonly publishedAt: string;
	readonly pinned?: boolean;
	readonly cta?: { readonly label: string; readonly href: string };
}
