import {
    CHANGELOG_LIMITS,
    CHANGELOG_SLUG_PATTERN,
    isChangelogCategory,
    isChangelogKind,
    isSafeInAppPath,
    type ChangelogCategory,
    type ChangelogCtaDto,
    type ChangelogKind,
    type ChangelogSourceEntry,
} from '@ever-works/contracts/api';

/**
 * What's new (AW-14) — the authoring rules, as pure functions.
 *
 * One implementation serves two callers: `ChangelogService` re-validates
 * whatever a content source yields on every load (spec FR-5 "re-validated
 * at load"), and `changelog.catalog.spec.ts` fails CI when the committed
 * entries break a rule, before a reviewer has to notice.
 */

/** A validated entry, ready to be sorted, filtered and served. */
export interface ChangelogCatalogEntry {
    slug: string;
    title: string;
    body: string;
    category: ChangelogCategory;
    kind: ChangelogKind;
    publishedAt: Date;
    pinned: boolean;
    cta: ChangelogCtaDto | null;
}

/** Something a record got wrong. `dropped` entries are not served at all. */
export interface ChangelogEntryIssue {
    slug: string;
    problem: string;
    dropped: boolean;
}

export interface ChangelogCatalogValidation {
    entries: ChangelogCatalogEntry[];
    issues: ChangelogEntryIssue[];
}

/**
 * Spec FR-39 — the in-product path guard. Defined once in contracts so the web
 * app re-checks a call-to-action with exactly the rule applied here; re-exported
 * so existing callers of this module keep a single import.
 */
export { isSafeInAppPath };

/** Paragraphs are separated by a blank line (spec FR-5: at most 3). */
export function countParagraphs(body: string): number {
    return body
        .split(/\n[ \t]*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0).length;
}

function parsePublishedAt(value: unknown): Date | null {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
        return null;
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function slugOf(entry: Partial<ChangelogSourceEntry> | null | undefined, index: number): string {
    return typeof entry?.slug === 'string' && entry.slug.length > 0 ? entry.slug : `#${index}`;
}

/**
 * Validate every record a content source yielded.
 *
 * A record that breaks a rule the reader would notice — its identifier,
 * title, body, category, kind or date — is DROPPED: serving it would render a
 * broken card or a duplicate permalink. A record whose call-to-action is
 * unusable keeps rendering without the button (spec FR-40), and a second
 * pinned record keeps rendering unpinned (spec FR-8), because in both cases
 * the entry itself is still correct.
 */
export function validateChangelogEntries(
    records: readonly (ChangelogSourceEntry | null | undefined)[],
): ChangelogCatalogValidation {
    const issues: ChangelogEntryIssue[] = [];
    const entries: ChangelogCatalogEntry[] = [];
    const seen = new Set<string>();

    records.forEach((record, index) => {
        const slug = slugOf(record, index);
        const drop = (problem: string) => issues.push({ slug, problem, dropped: true });

        if (!record || typeof record !== 'object') {
            drop('entry is not an object');
            return;
        }
        if (typeof record.slug !== 'string' || !CHANGELOG_SLUG_PATTERN.test(record.slug)) {
            drop('slug must match [a-z0-9-] and be 3-64 characters');
            return;
        }
        if (seen.has(record.slug)) {
            drop('slug is used by an earlier entry');
            return;
        }
        if (typeof record.title !== 'string' || record.title.trim().length === 0) {
            drop('title is empty');
            return;
        }
        if (record.title.length > CHANGELOG_LIMITS.titleMaxLength) {
            drop(`title is longer than ${CHANGELOG_LIMITS.titleMaxLength} characters`);
            return;
        }
        if (typeof record.body !== 'string' || record.body.trim().length === 0) {
            drop('body is empty');
            return;
        }
        if (record.body.length > CHANGELOG_LIMITS.bodyMaxLength) {
            drop(`body is longer than ${CHANGELOG_LIMITS.bodyMaxLength} characters`);
            return;
        }
        if (countParagraphs(record.body) > CHANGELOG_LIMITS.bodyMaxParagraphs) {
            drop(`body has more than ${CHANGELOG_LIMITS.bodyMaxParagraphs} paragraphs`);
            return;
        }
        if (!isChangelogCategory(record.category)) {
            drop('category is not one of the six product areas');
            return;
        }
        if (!isChangelogKind(record.kind)) {
            drop('kind is not one of new, improved, fixed, security');
            return;
        }
        const publishedAt = parsePublishedAt(record.publishedAt);
        if (!publishedAt) {
            drop('publishedAt is not an ISO-8601 date');
            return;
        }

        seen.add(record.slug);

        let cta: ChangelogCtaDto | null = null;
        if (record.cta !== undefined && record.cta !== null) {
            const { label, href } = record.cta as { label?: unknown; href?: unknown };
            if (typeof label !== 'string' || label.trim().length === 0) {
                issues.push({ slug, problem: 'cta label is empty', dropped: false });
            } else if (label.length > CHANGELOG_LIMITS.ctaLabelMaxLength) {
                issues.push({
                    slug,
                    problem: `cta label is longer than ${CHANGELOG_LIMITS.ctaLabelMaxLength} characters`,
                    dropped: false,
                });
            } else if (!isSafeInAppPath(href)) {
                issues.push({
                    slug,
                    problem: 'cta href is not an in-product path beginning with a single /',
                    dropped: false,
                });
            } else {
                cta = { label, href };
            }
        }

        entries.push({
            slug: record.slug,
            title: record.title,
            body: record.body,
            category: record.category,
            kind: record.kind,
            publishedAt,
            pinned: record.pinned === true,
            cta,
        });
    });

    // Spec FR-8 — at most one pinned entry. Keep the newest; the rest keep
    // rendering in date order.
    const pinned = entries.filter((entry) => entry.pinned).sort(compareByDateDesc);
    for (const extra of pinned.slice(1)) {
        extra.pinned = false;
        issues.push({
            slug: extra.slug,
            problem: 'another entry is already pinned',
            dropped: false,
        });
    }

    return { entries, issues };
}

/** Newest first; ties broken by slug ascending so ordering is stable. */
export function compareByDateDesc(a: ChangelogCatalogEntry, b: ChangelogCatalogEntry): number {
    const byDate = b.publishedAt.getTime() - a.publishedAt.getTime();
    if (byDate !== 0) {
        return byDate;
    }
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** Spec FR-8 — the pinned entry first, then newest first, ties by slug. */
export function compareForDisplay(a: ChangelogCatalogEntry, b: ChangelogCatalogEntry): number {
    if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
    }
    return compareByDateDesc(a, b);
}
