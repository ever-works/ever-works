import { describe, expect, it } from 'vitest';
import { isInAppDestination } from './destination';

describe('isInAppDestination', () => {
    it.each([
        '/missions/m1',
        '/',
        '/tasks/new?prompt=hello%20world',
        '/works/w1/kb/faq/refunds%3F%23top.md',
        '/teams/t1#members',
    ])('accepts the in-app path %j', (value) => {
        expect(isInAppDestination(value)).toBe(true);
    });

    it.each([
        ['an absolute URL', 'https://elsewhere.example'],
        ['a protocol-relative URL', '//elsewhere.example/missions/1'],
        ['a backslash host', '/\\elsewhere.example'],
        ['a tab before the host', '/\t/elsewhere.example'],
        ['a newline before the host', '/\n/elsewhere.example'],
        ['a carriage return before the host', '/\r/elsewhere.example'],
        ['a tab and a backslash', '/\t\\elsewhere.example'],
        ['a NUL character', `/missions/${String.fromCharCode(0)}m1`],
        ['a DEL character', `/missions/${String.fromCharCode(0x7f)}m1`],
        ['a relative path', 'missions/m1'],
        ['a javascript URL', 'javascript:alert(1)'],
        ['an empty string', ''],
    ])('rejects %s', (_label, value) => {
        expect(isInAppDestination(value)).toBe(false);
    });

    it('rejects anything that is not a string', () => {
        expect(isInAppDestination(undefined)).toBe(false);
        expect(isInAppDestination(null)).toBe(false);
        expect(isInAppDestination(42)).toBe(false);
        expect(isInAppDestination({ toString: () => '/missions/m1' })).toBe(false);
    });
});
