import { CHANGELOG_CATEGORIES, CHANGELOG_KINDS } from '@ever-works/contracts/api';
import { CHANGELOG_ENTRIES } from './changelog.catalog';
import { validateChangelogEntries } from './changelog-entry.validation';

/**
 * What's new (AW-14) — the authoring gate for the entries committed in this
 * repository. A record that breaks a rule fails CI here, with the offending
 * slug in the message, before a reviewer has to catch it.
 *
 * The rules themselves live in `changelog-entry.validation.ts` — the same
 * code the API runs when it loads entries — so this gate and runtime can
 * never disagree about what a valid entry is.
 */
describe('CHANGELOG_ENTRIES — the entries that ship with this build', () => {
    const { entries, issues } = validateChangelogEntries(CHANGELOG_ENTRIES);

    it('breaks no authoring rule (slug, title, body, category, kind, date, call-to-action, pinning)', () => {
        expect(issues.map((issue) => `${issue.slug}: ${issue.problem}`)).toEqual([]);
        expect(entries).toHaveLength(CHANGELOG_ENTRIES.length);
    });

    it('never reuses a slug', () => {
        const slugs = CHANGELOG_ENTRIES.map((entry) => entry.slug);
        const duplicates = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
        expect(duplicates).toEqual([]);
    });

    it('pins at most one entry', () => {
        expect(
            CHANGELOG_ENTRIES.filter((entry) => entry.pinned === true).length,
        ).toBeLessThanOrEqual(1);
    });

    it('keeps every call-to-action that was authored (none silently stripped)', () => {
        const authored = CHANGELOG_ENTRIES.filter((entry) => entry.cta).map((entry) => entry.slug);
        const served = entries.filter((entry) => entry.cta).map((entry) => entry.slug);
        expect(served).toEqual(authored);
    });

    it('seeds enough real entries for every surface to render something honest', () => {
        const published = CHANGELOG_ENTRIES.filter(
            (entry) => new Date(entry.publishedAt) <= new Date(),
        );
        expect(published.length).toBeGreaterThanOrEqual(5);
        expect(new Set(published.map((entry) => entry.category)).size).toBeGreaterThanOrEqual(3);
        expect(new Set(published.map((entry) => entry.kind)).size).toBeGreaterThanOrEqual(2);
        for (const entry of published) {
            expect(CHANGELOG_CATEGORIES).toContain(entry.category);
            expect(CHANGELOG_KINDS).toContain(entry.kind);
        }
    });
});
