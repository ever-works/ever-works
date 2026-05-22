import { describe, expect, it } from 'vitest';
import { rewriteWikilinks } from './wikilink-md';

describe('rewriteWikilinks', () => {
    const work = 'work-1';

    it('rewrites a label|path wikilink to a markdown link', () => {
        expect(rewriteWikilinks('See [[Brand voice|brand/voice.md]] for tone.', work)).toBe(
            'See [Brand voice](/works/work-1/kb/brand/voice.md) for tone.',
        );
    });

    it('rewrites a path-only wikilink and uses the basename without .md as label', () => {
        expect(rewriteWikilinks('See [[brand/voice.md]] for tone.', work)).toBe(
            'See [voice](/works/work-1/kb/brand/voice.md) for tone.',
        );
    });

    it('falls back to basename when label is empty', () => {
        expect(rewriteWikilinks('[[ |legal/notice.md]]', work)).toBe(
            '[notice](/works/work-1/kb/legal/notice.md)',
        );
    });

    it('rewrites multiple wikilinks in one paragraph', () => {
        const out = rewriteWikilinks('First [[a.md]] and second [[b/c.md]].', work);
        expect(out).toBe(
            'First [a](/works/work-1/kb/a.md) and second [c](/works/work-1/kb/b/c.md).',
        );
    });

    it('leaves wikilinks inside fenced code blocks alone', () => {
        const source = 'Before [[a.md]]\n\n```\n[[b.md]]\n```\n\nAfter [[c.md]]';
        const out = rewriteWikilinks(source, work);
        expect(out).toContain('Before [a](/works/work-1/kb/a.md)');
        expect(out).toContain('```\n[[b.md]]\n```');
        expect(out).toContain('After [c](/works/work-1/kb/c.md)');
    });

    it('leaves wikilinks inside inline code spans alone', () => {
        expect(rewriteWikilinks('Use `[[brand/voice.md]]` for tone', work)).toBe(
            'Use `[[brand/voice.md]]` for tone',
        );
    });

    it('rejects URL-scheme targets (defence-in-depth against XSS via wikilink)', () => {
        expect(rewriteWikilinks('[[evil|javascript:alert(1)]]', work)).toBe(
            '[[evil|javascript:alert(1)]]',
        );
        expect(rewriteWikilinks('[[mal|https://evil.example/x]]', work)).toBe(
            '[[mal|https://evil.example/x]]',
        );
    });

    it('rejects absolute paths + `..` traversal', () => {
        expect(rewriteWikilinks('[[abs|/etc/passwd]]', work)).toBe('[[abs|/etc/passwd]]');
        expect(rewriteWikilinks('[[trav|../secrets.md]]', work)).toBe('[[trav|../secrets.md]]');
        expect(rewriteWikilinks('[[trav|brand/../legal.md]]', work)).toBe(
            '[[trav|brand/../legal.md]]',
        );
    });

    it('rejects targets containing whitespace', () => {
        expect(rewriteWikilinks('[[bad|path with space.md]]', work)).toBe(
            '[[bad|path with space.md]]',
        );
    });

    it('returns the source unchanged when no wikilinks are present', () => {
        expect(rewriteWikilinks('Plain text with [a normal](link.md).', work)).toBe(
            'Plain text with [a normal](link.md).',
        );
    });

    it('handles the empty source string', () => {
        expect(rewriteWikilinks('', work)).toBe('');
    });

    it('URL-encodes the workId segment so a forced slash in workId cannot escape the route', () => {
        expect(rewriteWikilinks('[[a.md]]', 'work/with/slashes')).toBe(
            '[a](/works/work%2Fwith%2Fslashes/kb/a.md)',
        );
    });
});
