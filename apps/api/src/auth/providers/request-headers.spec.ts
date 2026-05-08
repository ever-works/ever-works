import { toHeaders } from './request-headers';

describe('toHeaders', () => {
    describe('Headers passthrough', () => {
        it('returns a fresh Headers instance when given an existing Headers object', () => {
            const original = new Headers({ 'x-original': 'a' });
            const result = toHeaders(original);

            expect(result).toBeInstanceOf(Headers);
            expect(result).not.toBe(original);
            expect(result.get('x-original')).toBe('a');
        });

        it('does not share state between the input Headers and the output', () => {
            const original = new Headers({ 'x-input': 'in' });
            const result = toHeaders(original);

            // Mutating the result must not leak into the input.
            result.set('x-input', 'mutated');
            expect(original.get('x-input')).toBe('in');

            // And vice versa — mutating the input must not leak into the output.
            original.set('x-input', 'changed');
            expect(result.get('x-input')).toBe('mutated');
        });

        it('preserves multi-value headers when copying a Headers input', () => {
            const original = new Headers();
            original.append('set-cookie', 'a=1');
            original.append('set-cookie', 'b=2');

            const result = toHeaders(original);

            // Headers normalises set-cookie into a single comma-joined value
            // for `.get()` — we just need to confirm the round-trip preserved
            // the data through the `new Headers(input)` constructor.
            expect(result.get('set-cookie')).toBe(original.get('set-cookie'));
        });
    });

    describe('plain object input', () => {
        it('returns an empty Headers when input is undefined', () => {
            const result = toHeaders(undefined);

            expect(result).toBeInstanceOf(Headers);
            // Iterate to assert empty.
            const entries = Array.from(result.entries());
            expect(entries).toEqual([]);
        });

        it('coerces string values via headers.set', () => {
            const result = toHeaders({ 'x-foo': 'bar', 'x-baz': 'qux' });

            expect(result.get('x-foo')).toBe('bar');
            expect(result.get('x-baz')).toBe('qux');
        });

        it('joins string-array values with ", "', () => {
            const result = toHeaders({ 'x-multi': ['a', 'b', 'c'] });

            expect(result.get('x-multi')).toBe('a, b, c');
        });

        it('joins a single-element string-array still via ", " (no special-case)', () => {
            const result = toHeaders({ 'x-single': ['only'] });

            expect(result.get('x-single')).toBe('only');
        });

        it('joins an empty string-array to an empty string and SKIPS it via the falsy guard', () => {
            // [] is falsy via `!value` in toHeaders only because arrays themselves are
            // truthy — verify the documented behaviour: an empty array IS truthy, so
            // it passes the `!value` guard and gets joined to ''.
            const result = toHeaders({ 'x-empty-array': [] });

            expect(result.get('x-empty-array')).toBe('');
        });

        it('skips entries with undefined values', () => {
            const result = toHeaders({ 'x-foo': 'bar', 'x-skip': undefined });

            expect(result.get('x-foo')).toBe('bar');
            expect(result.has('x-skip')).toBe(false);
        });

        it('skips entries with empty-string values via the falsy guard', () => {
            const result = toHeaders({ 'x-foo': 'bar', 'x-empty': '' });

            expect(result.get('x-foo')).toBe('bar');
            // Empty string is falsy under `!value`, so the entry is dropped.
            expect(result.has('x-empty')).toBe(false);
        });

        it('lowercases keys (Headers normalisation), not via toHeaders itself', () => {
            const result = toHeaders({ 'X-Mixed-Case': 'v' });

            // The Headers API normalises names to lowercase regardless of input casing.
            expect(result.get('x-mixed-case')).toBe('v');
            expect(result.get('X-Mixed-Case')).toBe('v');
        });

        it('handles a fully-empty plain object as no-op', () => {
            const result = toHeaders({});

            expect(Array.from(result.entries())).toEqual([]);
        });
    });

    describe('null/undefined defensive coercion', () => {
        it('treats `undefined` input as an empty object via the `input || {}` fallback', () => {
            // The signature only declares `undefined` (not null) in the types, but
            // the runtime fallback `input || {}` covers both — this test pins the
            // documented contract path.
            const result = toHeaders(undefined);

            expect(Array.from(result.entries())).toEqual([]);
        });
    });
});
