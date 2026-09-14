import type { ChangelogSourceEntry } from '@ever-works/contracts/api';
import {
    compareForDisplay,
    countParagraphs,
    isSafeInAppPath,
    validateChangelogEntries,
} from './changelog-entry.validation';

const base: ChangelogSourceEntry = {
    slug: 'valid-entry',
    title: 'A valid title',
    body: 'A valid body.',
    category: 'agents',
    kind: 'new',
    publishedAt: '2026-09-01T00:00:00.000Z',
};

const one = (overrides: Partial<ChangelogSourceEntry> | Record<string, unknown>) =>
    validateChangelogEntries([{ ...base, ...overrides } as ChangelogSourceEntry]);

describe('isSafeInAppPath (FR-39)', () => {
    it.each([
        '/',
        '/inbox',
        '/works/1',
        '/settings/usage?tab=costs',
        '/tasks/templates#top',
        '/a-b_c.d',
    ])('accepts %s', (href) => {
        expect(isSafeInAppPath(href)).toBe(true);
    });

    it.each([
        ['empty', ''],
        ['blank', '   '],
        ['protocol-relative', '//evil.example'],
        ['backslash-obfuscated', '/\\evil.example'],
        ['backslash anywhere', '/a\\b'],
        ['absolute URL', 'https://evil.example'],
        ['javascript scheme', 'javascript:alert(1)'],
        ['mailto scheme', 'mailto:a@b.c'],
        ['relative without slash', 'inbox'],
        ['tab-collapsed protocol-relative', '/\t/evil.example'],
        ['newline', '/inbox\n'],
        ['leading space', ' /inbox'],
        ['not a string', 42],
        ['null', null],
    ])('rejects %s', (_label, href) => {
        expect(isSafeInAppPath(href)).toBe(false);
    });
});

describe('countParagraphs', () => {
    it('counts blank-line separated paragraphs and ignores single line breaks', () => {
        expect(countParagraphs('one')).toBe(1);
        expect(countParagraphs('one\nstill one')).toBe(1);
        expect(countParagraphs('one\n\ntwo\n  \nthree')).toBe(3);
        expect(countParagraphs('\n\none\n\n\n\ntwo\n\n')).toBe(2);
    });
});

describe('validateChangelogEntries (FR-4..FR-10)', () => {
    it('accepts a well-formed entry and parses its date', () => {
        const { entries, issues } = one({});
        expect(issues).toEqual([]);
        expect(entries).toHaveLength(1);
        expect(entries[0].publishedAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
        expect(entries[0].pinned).toBe(false);
        expect(entries[0].cta).toBeNull();
    });

    it('accepts a date-only publishedAt', () => {
        expect(one({ publishedAt: '2026-09-01' }).entries).toHaveLength(1);
    });

    it.each([
        ['a malformed slug', { slug: 'Bad Slug' }],
        ['a two-character slug', { slug: 'ab' }],
        ['an empty title', { title: '  ' }],
        ['an 81-character title', { title: 'x'.repeat(81) }],
        ['an empty body', { body: '' }],
        ['a 601-character body', { body: 'x'.repeat(601) }],
        ['a four-paragraph body', { body: 'a\n\nb\n\nc\n\nd' }],
        ['an unknown category', { category: 'missions' }],
        ['an unknown kind', { kind: 'breaking' }],
        ['an unparseable date', { publishedAt: 'yesterday' }],
        ['a non-ISO date', { publishedAt: 'September 1, 2026' }],
    ])('drops an entry with %s and names it', (_label, overrides) => {
        const { entries, issues } = one(overrides);
        expect(entries).toEqual([]);
        expect(issues).toHaveLength(1);
        expect(issues[0].dropped).toBe(true);
    });

    it('accepts the exact limits', () => {
        const { entries, issues } = one({
            title: 'x'.repeat(80),
            body: `${'x'.repeat(196)}\n\n${'y'.repeat(200)}\n\n${'z'.repeat(200)}`,
            cta: { label: 'l'.repeat(32), href: '/inbox' },
        });
        expect(issues).toEqual([]);
        expect(entries[0].cta).toEqual({ label: 'l'.repeat(32), href: '/inbox' });
    });

    it('drops a later duplicate slug and keeps the first', () => {
        const { entries, issues } = validateChangelogEntries([
            { ...base, title: 'First' },
            { ...base, title: 'Second' },
        ]);
        expect(entries.map((e) => e.title)).toEqual(['First']);
        expect(issues).toEqual([
            { slug: 'valid-entry', problem: 'slug is used by an earlier entry', dropped: true },
        ]);
    });

    it('drops null and non-object records', () => {
        const { entries, issues } = validateChangelogEntries([null, undefined, base]);
        expect(entries).toHaveLength(1);
        expect(issues.map((issue) => issue.slug)).toEqual(['#0', '#1']);
    });

    it.each([
        ['an off-origin href', { label: 'Go', href: 'https://evil.example' }],
        ['a protocol-relative href', { label: 'Go', href: '//evil.example' }],
        ['a 33-character label', { label: 'l'.repeat(33), href: '/inbox' }],
        ['an empty label', { label: '', href: '/inbox' }],
    ])('FR-40: keeps the entry but removes a call-to-action with %s', (_label, cta) => {
        const { entries, issues } = one({ cta });
        expect(entries).toHaveLength(1);
        expect(entries[0].cta).toBeNull();
        expect(issues).toHaveLength(1);
        expect(issues[0].dropped).toBe(false);
    });

    it('FR-8: keeps only the newest pinned entry pinned', () => {
        const { entries, issues } = validateChangelogEntries([
            {
                ...base,
                slug: 'older-pinned',
                publishedAt: '2026-08-01T00:00:00.000Z',
                pinned: true,
            },
            {
                ...base,
                slug: 'newer-pinned',
                publishedAt: '2026-09-01T00:00:00.000Z',
                pinned: true,
            },
        ]);
        expect(entries.find((e) => e.slug === 'newer-pinned')?.pinned).toBe(true);
        expect(entries.find((e) => e.slug === 'older-pinned')?.pinned).toBe(false);
        expect(issues).toEqual([
            { slug: 'older-pinned', problem: 'another entry is already pinned', dropped: false },
        ]);
    });

    it('FR-8: display order is pinned first, then newest, then slug', () => {
        const { entries } = validateChangelogEntries([
            { ...base, slug: 'bbb-same-day', publishedAt: '2026-09-02T00:00:00.000Z' },
            { ...base, slug: 'old-pinned', publishedAt: '2026-01-01T00:00:00.000Z', pinned: true },
            { ...base, slug: 'aaa-same-day', publishedAt: '2026-09-02T00:00:00.000Z' },
            { ...base, slug: 'newest', publishedAt: '2026-09-03T00:00:00.000Z' },
        ]);
        expect([...entries].sort(compareForDisplay).map((e) => e.slug)).toEqual([
            'old-pinned',
            'newest',
            'aaa-same-day',
            'bbb-same-day',
        ]);
    });
});
