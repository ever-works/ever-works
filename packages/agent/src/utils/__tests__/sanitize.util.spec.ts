import {
    sanitizeText,
    sanitizeDescription,
    sanitizeName,
    sanitizePrompt,
    sanitizeObject,
    sanitizeStringTransform,
    sanitizeDescriptionTransform,
    sanitizeStringArray,
    type SanitizeTextOptions,
} from '../sanitize.util';

describe('sanitizeText', () => {
    describe('falsy inputs', () => {
        it.each([
            ['undefined', undefined],
            ['null', null],
            ['empty string', ''],
        ] as Array<[string, string | null | undefined]>)(
            'returns empty string for %s',
            (_label, input) => {
                expect(sanitizeText(input)).toBe('');
            },
        );
    });

    describe('default options', () => {
        it('removes control chars (except \\n, \\r, \\t)', () => {
            // 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F should all be stripped.
            const input = `a\x00b\x08c\x0Bd\x0Ce\x1Ff\x7Fg`;
            expect(sanitizeText(input)).toBe('abcdefg');
        });

        it('preserves \\n, \\r, \\t when removeControlChars runs but treats them via separate rules', () => {
            // \n and \r should be replaced with space by the removeNewlines pass
            // (default true). \t is collapsed by collapseSpaces.
            expect(sanitizeText('a\nb\rc\td')).toBe('a b c d');
        });

        it('replaces newlines with single space then collapses', () => {
            expect(sanitizeText('a\n\n\nb')).toBe('a b');
            expect(sanitizeText('a\r\nb')).toBe('a b');
        });

        it('collapses multiple spaces into one', () => {
            expect(sanitizeText('a    b   c')).toBe('a b c');
        });

        it('trims leading and trailing whitespace', () => {
            expect(sanitizeText('   hello   ')).toBe('hello');
        });

        it('combines all default passes correctly', () => {
            expect(sanitizeText('  Hello\n\n  World  \x00!  ')).toBe('Hello World !');
        });
    });

    describe('option overrides', () => {
        it('honours removeNewlines:false (preserves newlines)', () => {
            const result = sanitizeText('a\nb', { removeNewlines: false, collapseSpaces: false });
            expect(result).toBe('a\nb');
        });

        it('honours collapseSpaces:false (preserves runs)', () => {
            const result = sanitizeText('a    b', {
                collapseSpaces: false,
                removeNewlines: false,
            });
            expect(result).toBe('a    b');
        });

        it('honours trim:false (preserves padding)', () => {
            const result = sanitizeText('  hi  ', {
                trim: false,
                collapseSpaces: false,
                removeNewlines: false,
            });
            expect(result).toBe('  hi  ');
        });

        it('honours removeControlChars:false (preserves control bytes)', () => {
            const result = sanitizeText('a\x00b', {
                removeControlChars: false,
                collapseSpaces: false,
                removeNewlines: false,
                trim: false,
            });
            expect(result).toBe('a\x00b');
        });

        it('partial options merge with DEFAULT_OPTIONS (does not unset other defaults)', () => {
            // maxLength only — other defaults still apply.
            const result = sanitizeText('  hello   world  ', { maxLength: 100 });
            expect(result).toBe('hello world');
        });
    });

    describe('maxLength truncation', () => {
        it('truncates at maxLength and trims again', () => {
            // Truncation cuts mid-word and the trailing whitespace from the
            // cut is trimmed away by the post-truncate `.trim()`.
            expect(sanitizeText('hello world how are you', { maxLength: 10 })).toBe('hello worl');
        });

        it('post-truncate trim drops trailing space left by the cut', () => {
            // The substring "hello " ends with a space which gets trimmed.
            expect(sanitizeText('hello world', { maxLength: 6 })).toBe('hello');
        });

        it('does not truncate when length <= maxLength', () => {
            expect(sanitizeText('short', { maxLength: 100 })).toBe('short');
        });

        it('treats maxLength=0 as falsy → no truncation', () => {
            // The source uses `if (opts.maxLength && ...)` so 0 is falsy.
            expect(sanitizeText('hello world', { maxLength: 0 })).toBe('hello world');
        });

        it('treats undefined maxLength → no truncation', () => {
            expect(sanitizeText('hello world')).toBe('hello world');
        });
    });

    describe('order of operations', () => {
        it('runs removeControlChars BEFORE removeNewlines BEFORE collapseSpaces BEFORE trim BEFORE maxLength', () => {
            // Input has control char + newline + multiple spaces + leading/trailing whitespace,
            // and is longer than maxLength.
            const input = '   \x00 Hello\n  World  \x00 longerstuff   ';
            const result = sanitizeText(input, { maxLength: 11 });
            // After control-strip + newline-replace + collapse + trim:
            // 'Hello World longerstuff'
            // Truncate at 11 → 'Hello World' → trim trailing → 'Hello World'
            expect(result).toBe('Hello World');
        });
    });
});

describe('sanitizeDescription', () => {
    it('uses default 500-char cap', () => {
        const long = 'a'.repeat(600);
        expect(sanitizeDescription(long)).toHaveLength(500);
    });

    it('honours custom maxLength', () => {
        expect(sanitizeDescription('a'.repeat(50), 20)).toHaveLength(20);
    });

    it('strips newlines, control bytes, and collapses spaces', () => {
        expect(sanitizeDescription('  hi\n\nthere\x00 ')).toBe('hi there');
    });

    it('returns "" for falsy input', () => {
        expect(sanitizeDescription(undefined)).toBe('');
        expect(sanitizeDescription(null)).toBe('');
    });
});

describe('sanitizeName', () => {
    it('uses default 100-char cap', () => {
        const long = 'a'.repeat(150);
        expect(sanitizeName(long)).toHaveLength(100);
    });

    it('honours custom maxLength', () => {
        expect(sanitizeName('a'.repeat(50), 20)).toHaveLength(20);
    });

    it('strips newlines + collapses spaces (same shape as description)', () => {
        expect(sanitizeName('  Foo\nBar  ')).toBe('Foo Bar');
    });
});

describe('sanitizePrompt', () => {
    it('uses default 5000-char cap', () => {
        const long = 'a'.repeat(6000);
        expect(sanitizePrompt(long)).toHaveLength(5000);
    });

    it('PRESERVES newlines (prompts can be multi-line)', () => {
        expect(sanitizePrompt('Line 1\nLine 2\nLine 3')).toBe('Line 1\nLine 2\nLine 3');
    });

    it('PRESERVES multi-space runs (no collapseSpaces)', () => {
        expect(sanitizePrompt('a    b   c')).toBe('a    b   c');
    });

    it('still trims leading/trailing whitespace', () => {
        expect(sanitizePrompt('   hi   ')).toBe('hi');
    });

    it('still strips control chars (except \\n, \\r, \\t)', () => {
        expect(sanitizePrompt('a\x00b\x07c')).toBe('abc');
    });

    it('honours custom maxLength', () => {
        expect(sanitizePrompt('a'.repeat(100), 30)).toHaveLength(30);
    });
});

describe('sanitizeObject', () => {
    it('returns the input verbatim when not an object', () => {
        // The signature accepts `T extends Record<string, unknown>` but the
        // runtime guard is defensive and returns falsy values as-is.
        expect(sanitizeObject(null as any)).toBeNull();
        expect(sanitizeObject(undefined as any)).toBeUndefined();
    });

    it('sanitizes top-level string fields', () => {
        const result = sanitizeObject({ name: '  Foo  ', count: 7 });
        expect(result).toEqual({ name: 'Foo', count: 7 });
    });

    it('does not mutate the input object', () => {
        const input = { name: '  Foo  ' };
        const result = sanitizeObject(input);
        expect(input.name).toBe('  Foo  ');
        expect(result).not.toBe(input); // Distinct reference.
        expect(result.name).toBe('Foo');
    });

    it('recurses into nested object values', () => {
        const result = sanitizeObject({ a: 1, nested: { b: '  bar  ', c: { d: '  deep  ' } } });
        expect(result).toEqual({ a: 1, nested: { b: 'bar', c: { d: 'deep' } } });
    });

    it('walks string elements inside arrays', () => {
        const result = sanitizeObject({ tags: ['  a  ', '  b  '] });
        expect(result).toEqual({ tags: ['a', 'b'] });
    });

    it('recurses into object elements inside arrays', () => {
        const result = sanitizeObject({ items: [{ name: '  one  ' }, { name: '  two  ' }] });
        expect(result).toEqual({ items: [{ name: 'one' }, { name: 'two' }] });
    });

    it('preserves non-string non-object array elements verbatim', () => {
        const input = { mixed: [1, true, null as any, '  trim me  '] };
        const result = sanitizeObject(input);
        expect(result).toEqual({ mixed: [1, true, null, 'trim me'] });
    });

    it('forwards options into the recursive call', () => {
        const opts: SanitizeTextOptions = {
            maxLength: 5,
            trim: true,
            removeControlChars: true,
            removeNewlines: true,
            collapseSpaces: true,
        };
        const result = sanitizeObject({ a: 'hello world', nested: { b: 'hello world' } }, opts);
        expect(result).toEqual({ a: 'hello', nested: { b: 'hello' } });
    });

    it('skips null nested values without crashing', () => {
        // The `value && typeof value === 'object'` guard short-circuits null.
        const result = sanitizeObject({ a: null as any, b: '  hi  ' });
        expect(result).toEqual({ a: null, b: 'hi' });
    });
});

describe('sanitizeStringTransform', () => {
    it('sanitizes when input is a string', () => {
        expect(sanitizeStringTransform('  Hello\n  ')).toBe('Hello');
    });

    it('forwards non-string input verbatim (cast to string at type level)', () => {
        expect(sanitizeStringTransform(42 as unknown)).toBe(42);
        expect(sanitizeStringTransform(null as unknown)).toBeNull();
        expect(sanitizeStringTransform(undefined as unknown)).toBeUndefined();
    });
});

describe('sanitizeDescriptionTransform', () => {
    it('sanitizes when input is a string (using description rules)', () => {
        expect(sanitizeDescriptionTransform('  Multi\n\nLine\x00 ')).toBe('Multi Line');
    });

    it('caps at 500 chars by default', () => {
        const long = 'a'.repeat(600);
        expect(sanitizeDescriptionTransform(long)).toHaveLength(500);
    });

    it('forwards non-string input verbatim', () => {
        expect(sanitizeDescriptionTransform(42 as unknown)).toBe(42);
        expect(sanitizeDescriptionTransform(null as unknown)).toBeNull();
    });
});

describe('sanitizeStringArray', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['non-array', 'not-an-array' as unknown as string[]],
        ['empty array', []],
    ] as Array<[string, string[] | null | undefined]>)('returns [] for %s', (_label, input) => {
        expect(sanitizeStringArray(input)).toEqual([]);
    });

    it('trims each entry then drops empty strings', () => {
        const result = sanitizeStringArray(['  a  ', '   ', 'b', '', '\x00 c\x00']);
        expect(result).toEqual(['a', 'b', 'c']);
    });

    it('collapses internal whitespace in each entry', () => {
        expect(sanitizeStringArray(['hello   world', 'foo\nbar'])).toEqual([
            'hello world',
            'foo bar',
        ]);
    });

    it('preserves order of surviving entries', () => {
        expect(sanitizeStringArray(['z', '   ', 'a', '   ', 'm'])).toEqual(['z', 'a', 'm']);
    });
});
