/**
 * What's new (AW-14) — closed vocabularies for product changelog entries.
 *
 * Nothing persists a category or a kind: entries come from a content source
 * that ships with the build, and only per-person read state is stored. These
 * tuples are therefore the single definition both the API and the web app
 * validate against.
 */

/**
 * The product area an entry belongs to (spec FR-9). A closed set of six —
 * adding a seventh is a spec change, not an authoring decision. Drives the
 * filter chips in the What's new panel.
 */
export const CHANGELOG_CATEGORIES = ['agents', 'decisions', 'knowledge', 'connections', 'costs', 'platform'] as const;
export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number];

/**
 * What kind of change an entry describes (spec FR-10). Rendered as a badge
 * only — kind is never a filter dimension.
 */
export const CHANGELOG_KINDS = ['new', 'improved', 'fixed', 'security'] as const;
export type ChangelogKind = (typeof CHANGELOG_KINDS)[number];

/** Narrowing guard for a category read from an untrusted source (query string, content file). */
export function isChangelogCategory(value: unknown): value is ChangelogCategory {
	return typeof value === 'string' && (CHANGELOG_CATEGORIES as readonly string[]).includes(value);
}

/** Narrowing guard for a kind read from an untrusted source. */
export function isChangelogKind(value: unknown): value is ChangelogKind {
	return typeof value === 'string' && (CHANGELOG_KINDS as readonly string[]).includes(value);
}

/** A backslash, any whitespace, or any control character (C0, DEL, C1). */
const UNSAFE_PATH_CHARACTER = /[\\\s\p{Cc}]/u;

/**
 * Spec FR-39 — is `raw` an in-product path a call-to-action may navigate to?
 *
 * True only for a string that begins with exactly one `/` and carries no
 * backslash, whitespace or control character anywhere. That single rule
 * rejects every form FR-39 names: an absolute URL to another origin or any
 * scheme-bearing string (neither can start with `/`), a protocol-relative
 * `//host`, a backslash-obfuscated `/\host`, and `/<tab>/host`, which
 * browsers collapse to `//host` because they strip tabs and newlines from
 * URLs before parsing them.
 *
 * Shared so the API (which drops an unsafe call-to-action when it loads
 * entries) and every client (which re-checks before rendering the button)
 * apply the identical rule.
 */
export function isSafeInAppPath(raw: unknown): raw is string {
	if (typeof raw !== 'string' || raw.length === 0) {
		return false;
	}
	if (raw[0] !== '/' || raw[1] === '/') {
		return false;
	}
	return !UNSAFE_PATH_CHARACTER.test(raw);
}

/**
 * Stable entry identifier grammar (spec FR-6): a lowercase slug of 3–64
 * characters. It is the permalink and is never reused for a different entry.
 */
export const CHANGELOG_SLUG_PATTERN = /^[a-z0-9-]{3,64}$/;

/** Authoring limits (spec FR-5, FR-17, FR-15, FR-26, FR-27). */
export const CHANGELOG_LIMITS = {
	titleMaxLength: 80,
	bodyMaxLength: 600,
	bodyMaxParagraphs: 3,
	ctaLabelMaxLength: 32,
	/** Most slugs one mark-read write may carry. */
	markReadBatchMax: 25,
	/** The unread count only ever considers this many of the newest entries. */
	unreadWindow: 50,
	/** Default page size for the panel and the full list. */
	pageSize: 20,
	/** Largest page a client may request. */
	pageSizeMax: 50,
	/** The deepest the list can be paged. */
	listMax: 200
} as const;
