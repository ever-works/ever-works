import { describe, expect, it } from 'vitest';
import {
    canonicalRepositoryUrl,
    isCanonicalWorkSlug,
    parseRepositoryUrl,
    slugifyForWork,
} from './repository-url';

/**
 * These live here rather than beside the form because the composers route
 * through them: a review found that whatever the user typed was being handed
 * to the Repository form through the query string, so a pasted remote holding
 * a token reached browser history and every later referrer.
 */
describe('canonicalRepositoryUrl', () => {
    it('reduces the accepted spellings to one canonical https URL', () => {
        for (const input of [
            'https://github.com/ever-works/ever-works',
            'http://github.com/ever-works/ever-works',
            'https://www.github.com/ever-works/ever-works',
            'github.com/ever-works/ever-works',
            'https://github.com/ever-works/ever-works.git',
            'https://github.com/ever-works/ever-works/',
            '  https://github.com/ever-works/ever-works  ',
        ]) {
            expect(canonicalRepositoryUrl(input)).toBe('https://github.com/ever-works/ever-works');
        }
    });

    it('refuses a remote that carries credentials, so none can reach the query string', () => {
        for (const input of [
            'https://user:ghp_secret@github.com/ever-works/ever-works',
            'https://ghp_secret@github.com/ever-works/ever-works.git',
            'git@github.com:ever-works/ever-works.git',
        ]) {
            expect(canonicalRepositoryUrl(input)).toBeNull();
        }
    });

    it('refuses query strings, fragments and other hosts', () => {
        expect(canonicalRepositoryUrl('https://github.com/o/r?token=abc')).toBeNull();
        expect(canonicalRepositoryUrl('https://github.com/o/r#frag')).toBeNull();
        expect(canonicalRepositoryUrl('https://gitlab.com/o/r')).toBeNull();
        expect(canonicalRepositoryUrl('https://evil.com/github.com/o/r')).toBeNull();
        expect(canonicalRepositoryUrl('just some prose the user typed')).toBeNull();
    });
});

describe('parseRepositoryUrl', () => {
    it('accepts a repository whose name starts with a dot, but not an owner', () => {
        expect(parseRepositoryUrl('https://github.com/ever-works/.github')).toEqual({
            owner: 'ever-works',
            repo: '.github',
        });
        expect(parseRepositoryUrl('https://github.com/.ever-works/repo')).toBeNull();
    });

    it('rejects the path components . and ..', () => {
        expect(parseRepositoryUrl('https://github.com/ever-works/.')).toBeNull();
        expect(parseRepositoryUrl('https://github.com/ever-works/..')).toBeNull();
    });
});

describe('isCanonicalWorkSlug', () => {
    it('accepts only a slug the API would store unchanged', () => {
        expect(isCanonicalWorkSlug('my-repo')).toBe(true);
        expect(isCanonicalWorkSlug('repo123')).toBe(true);
        // The form submits from a button handler, so the input's `pattern`
        // never runs: these all used to reach the server action.
        expect(isCanonicalWorkSlug('My_Repo')).toBe(false);
        expect(isCanonicalWorkSlug('my repo')).toBe(false);
        expect(isCanonicalWorkSlug('-my-repo-')).toBe(false);
        expect(isCanonicalWorkSlug('')).toBe(false);
        expect(isCanonicalWorkSlug('   ')).toBe(false);
    });

    it('agrees with slugifyForWork on what canonical means', () => {
        for (const raw of ['My_Repo', 'my repo', '-my-repo-', 'Ever Works!']) {
            expect(isCanonicalWorkSlug(slugifyForWork(raw))).toBe(true);
        }
    });
});
