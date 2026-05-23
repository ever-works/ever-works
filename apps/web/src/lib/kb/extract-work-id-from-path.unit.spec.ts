import { describe, expect, it } from 'vitest';
import { extractWorkIdFromPath } from './extract-work-id-from-path';

describe('extractWorkIdFromPath (row 35e)', () => {
    it('returns null for non-string input', () => {
        expect(extractWorkIdFromPath(null)).toBeNull();
        expect(extractWorkIdFromPath(undefined)).toBeNull();
    });

    it('returns null for empty / whitespace path', () => {
        expect(extractWorkIdFromPath('')).toBeNull();
        expect(extractWorkIdFromPath('   ')).toBeNull();
    });

    it('returns null for paths that do not match the Work shape', () => {
        expect(extractWorkIdFromPath('/en')).toBeNull();
        expect(extractWorkIdFromPath('/en/dashboard')).toBeNull();
        expect(extractWorkIdFromPath('/en/works')).toBeNull();
        expect(extractWorkIdFromPath('/en/items/123')).toBeNull();
    });

    it('extracts the Work id from a bare /works/:id', () => {
        expect(extractWorkIdFromPath('/en/works/work-abc')).toBe('work-abc');
    });

    it('extracts the Work id from a nested /works/:id/... path', () => {
        expect(extractWorkIdFromPath('/en/works/work-abc/items')).toBe('work-abc');
        expect(extractWorkIdFromPath('/en/works/work-abc/kb')).toBe('work-abc');
        expect(extractWorkIdFromPath('/en/works/work-abc/kb/brand/voice')).toBe('work-abc');
    });

    it('handles UUID-style ids', () => {
        const uuid = '5b1f9c4e-9b1f-4c4e-9b1f-9c4e9b1f4c4e';
        expect(extractWorkIdFromPath(`/en/works/${uuid}`)).toBe(uuid);
        expect(extractWorkIdFromPath(`/en/works/${uuid}/kb`)).toBe(uuid);
    });

    it('survives different locale prefixes', () => {
        expect(extractWorkIdFromPath('/fr/works/work-abc/kb')).toBe('work-abc');
        expect(extractWorkIdFromPath('/zh/works/work-abc/kb')).toBe('work-abc');
        expect(extractWorkIdFromPath('/ar/works/work-abc/kb')).toBe('work-abc');
    });

    it('ignores query string + hash after the id', () => {
        expect(extractWorkIdFromPath('/en/works/work-abc?tab=kb')).toBe('work-abc');
        expect(extractWorkIdFromPath('/en/works/work-abc#section')).toBe('work-abc');
    });

    it('returns null when there is no locale segment (/works at root)', () => {
        // The dashboard route is locale-prefixed in this project, so a
        // bare `/works/:id` is not expected and we conservatively reject.
        expect(extractWorkIdFromPath('/works/work-abc')).toBeNull();
    });

    it('returns null for the index/list page /works without id', () => {
        expect(extractWorkIdFromPath('/en/works')).toBeNull();
        expect(extractWorkIdFromPath('/en/works/')).toBeNull();
    });
});
