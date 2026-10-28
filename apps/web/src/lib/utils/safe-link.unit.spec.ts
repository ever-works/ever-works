import { describe, expect, it } from 'vitest';
import { safeHttpsUrl, safeWebUrl } from './safe-link';

const SCRIPT_BEARING = [
    'javascript:alert(1)',
    'JavaScript:alert(document.cookie)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
];

describe('safeHttpsUrl', () => {
    it('accepts a plain https URL and returns it as written', () => {
        expect(safeHttpsUrl('https://github.com/acme/repo/pull/7')).toBe(
            'https://github.com/acme/repo/pull/7',
        );
        expect(safeHttpsUrl('  https://github.com/acme/repo  ')).toBe(
            'https://github.com/acme/repo',
        );
    });

    it.each([...SCRIPT_BEARING, 'http://github.com/acme/repo/pull/7'])('refuses %j', (raw) => {
        expect(safeHttpsUrl(raw)).toBeNull();
    });

    it('refuses embedded credentials, relative values and junk', () => {
        expect(safeHttpsUrl('https://github.com@evil.invalid/pull/1')).toBeNull();
        expect(safeHttpsUrl('https://user:pw@evil.invalid/pull/1')).toBeNull();
        expect(safeHttpsUrl('/pull/1')).toBeNull();
        expect(safeHttpsUrl('//evil.invalid/pull/1')).toBeNull();
        expect(safeHttpsUrl('not a url')).toBeNull();
        expect(safeHttpsUrl('')).toBeNull();
        expect(safeHttpsUrl(null)).toBeNull();
        expect(safeHttpsUrl(undefined)).toBeNull();
        expect(safeHttpsUrl(42 as unknown as string)).toBeNull();
    });
});

describe('safeWebUrl', () => {
    it('accepts http and https', () => {
        expect(safeWebUrl('https://my-site.example')).toBe('https://my-site.example');
        expect(safeWebUrl('http://git.lan/acme/repo')).toBe('http://git.lan/acme/repo');
    });

    it.each(SCRIPT_BEARING)('refuses %j', (raw) => {
        expect(safeWebUrl(raw)).toBeNull();
    });

    it('refuses embedded credentials and relative values', () => {
        expect(safeWebUrl('http://user:pw@evil.invalid/')).toBeNull();
        expect(safeWebUrl('/dashboard')).toBeNull();
        expect(safeWebUrl(null)).toBeNull();
    });
});
