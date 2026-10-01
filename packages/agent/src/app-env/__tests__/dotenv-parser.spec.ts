import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    APP_ENV_DOTENV_MAX_BYTES,
    APP_ENV_DOTENV_MAX_LINES,
    APP_ENV_NAME_PATTERN,
    APP_ENV_RESERVED_PREFIX,
    APP_ENV_VALUE_MAX_BYTES,
} from '@ever-works/contracts';
import {
    parseAppEnvDotenv,
    type AppEnvDotenvEntry,
    type AppEnvDotenvLimits,
    type AppEnvDotenvParsed,
    type AppEnvDotenvParseResult,
    type AppEnvDotenvRefusal,
} from '../dotenv-parser';

/**
 * APW-07 T12 — the `.env` import parser, plan §4.5 (`plan.md:413-420`).
 *
 * Spec: FR-28 (`spec.md:283-285`, the paste grammar), FR-29 (`spec.md:286-288`,
 * one outcome per line, a refusal names its line), FR-30 (`spec.md:289-290`, the
 * paste is never stored, logged or echoed), ACC-07-11 (`spec.md:590-591`, the
 * 12-line fixture). The fixture T12 creates lives at
 * `__tests__/fixtures/import-12-lines.env` (`tasks.md:176-177`) and is read here
 * rather than inlined: it is the same file T13's service spec and T24's controller
 * spec import, so the 9/2/1 outcome chain is asserted against one set of bytes.
 *
 * ## What this spec is shaped around
 *
 *  1. **The fixture, exactly** — 11 entries and 1 refusal at line 7, with the
 *     names, values and line numbers spelled out. ACC-07-11 is the acceptance
 *     criterion and a count-only assertion would pass on the wrong 11.
 *  2. **The scanner's two dangerous edges**: a value that spans lines (the line
 *     counter must keep up, or every refusal after it is blamed on the wrong
 *     line — which is the member's only handle on the problem) and a malformed
 *     line that must never rewind the cursor (an off-by-one there is an infinite
 *     loop, not a failing assertion, so the line after it is asserted too).
 *  3. **FR-30 as three separate facts**: no `console` call (spies), no logger in
 *     the source (a comment-stripped scan, the same technique
 *     `generators.spec.ts:530-554` uses for FR-11), and no refusal message
 *     carrying the name or the value.
 *
 * ## The one branch this spec cannot execute, and why that is asserted
 *
 * `valueTooLarge` inside a quoted value is **unreachable** while
 * `APP_ENV_DOTENV_MAX_BYTES <= APP_ENV_VALUE_MAX_BYTES`: unescaping never grows a
 * value (`\n` is one byte either way, an unknown escape keeps its two characters)
 * and the whole paste is already at or below the value ceiling. Rather than
 * pretend to cover it, the inequality itself is asserted below — so raising the
 * paste ceiling without revisiting that branch fails here, with a message that
 * says why, instead of leaving an untested path in the parser.
 */

/** The fixture of ACC-07-11, read once: the bytes T13 and T24 also parse. */
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'import-12-lines.env'), 'utf8');

/** The names the fixture declares, in the order it declares them (line numbers below). */
const FIXTURE_NAMES = [
    'NEXT_PUBLIC_WEBAPP_URL',
    'NEXTAUTH_URL',
    'APP_WEB_INTERNAL_URL',
    'SMTP_PASSWORD',
    'LICENSE_KEY',
    'SUPPORT_EMAIL',
    'TURBO_TELEMETRY_DISABLED',
    'DATABASE_HOST',
    'FOO',
    'BAR',
    'CALCOM_TELEMETRY_DISABLED',
];

/**
 * Narrows a result to the parsed arm, failing loudly rather than casting.
 *
 * The switch is on `kind` and not on `ok`: this package compiles with
 * `strictNullChecks: false`, which widens a `true`/`false` property to `boolean`,
 * so `ok` does not narrow a union here while a string discriminant does.
 */
function parsed(result: AppEnvDotenvParseResult): AppEnvDotenvParsed {
    if (result.kind !== 'parsed') {
        throw new Error(
            `expected a parsed result, got the pre-parse limit ${result.code} (${result.actual} > ${result.limit})`,
        );
    }
    return result;
}

/** Narrows a result to the limit arm. */
function limited(result: AppEnvDotenvParseResult): AppEnvDotenvLimits {
    if (result.kind !== 'limits') {
        throw new Error(`expected a pre-parse limit refusal, got ${result.entries.length} entries`);
    }
    return result;
}

/** The value of one entry by name — a failure here names the missing key. */
function valueOf(result: AppEnvDotenvParsed, name: string): string | undefined {
    return result.entries.find((entry) => entry.name === name)?.value;
}

/** Parse one paste that is expected to succeed. */
function parseOk(text: string): AppEnvDotenvParsed {
    return parsed(parseAppEnvDotenv(text));
}

/** A paste of exactly `lines` valid lines. */
function lines(count: number): string {
    return Array.from({ length: count }, (_, index) => `K${index}=${index}`).join('\n');
}

describe('AppEnv .env parser (T12, plan §4.5:413-420)', () => {
    describe('ACC-07-11 — the 12-line fixture', () => {
        const result = parseOk(FIXTURE);

        it('yields exactly 11 entries and 1 refusal', () => {
            expect(result.entries).toHaveLength(11);
            expect(result.refused).toHaveLength(1);
            expect(result.duplicates).toHaveLength(0);
            expect(result.lines).toBe(12);
        });

        it('refuses line 7, and only line 7', () => {
            // The fixture's bad line is prose that happens to contain an `=`
            // (`this line is not a NAME=value line`), so the parser finds a `=`,
            // reads `this line is not a NAME` as the name and refuses it as
            // `invalidName` — the more informative of the two answers, and the one
            // a member can act on. A line with no `=` at all is the
            // `malformedLine` case, asserted separately below. ACC-07-11 fixes the
            // line number and the count, not the reason.
            expect(result.refused).toEqual([
                {
                    line: 7,
                    reason: 'invalidName',
                    message: `Line 7 doesn't start with a valid environment variable name (names match ${APP_ENV_NAME_PATTERN}).`,
                },
            ]);
        });

        it('reads every name, in order, with the line it came from', () => {
            expect(result.entries.map((entry) => entry.name)).toEqual(FIXTURE_NAMES);
            expect(result.entries.map((entry) => entry.line)).toEqual([
                1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12,
            ]);
        });

        it('resolves the three value forms the fixture exercises', () => {
            // Unquoted, single-quoted (the `#` inside stays literal) and
            // double-quoted — the fixture's first four lines are one of each.
            expect(valueOf(result, 'NEXT_PUBLIC_WEBAPP_URL')).toBe('https://cal.example.com');
            expect(valueOf(result, 'NEXTAUTH_URL')).toBe('https://cal.example.com/api/auth');
            expect(valueOf(result, 'APP_WEB_INTERNAL_URL')).toBe(
                'http://web.default.svc.cluster.local:3000',
            );
            expect(valueOf(result, 'SMTP_PASSWORD')).toBe('p@ss word #1');
            expect(valueOf(result, 'TURBO_TELEMETRY_DISABLED')).toBe('0');
        });
    });

    describe('FR-28 — the paste grammar', () => {
        it('accepts an `export ` prefix, with one space or several', () => {
            expect(valueOf(parseOk('export FOO=1'), 'FOO')).toBe('1');
            expect(valueOf(parseOk('export\tFOO=1'), 'FOO')).toBe('1');
            expect(valueOf(parseOk('export   FOO=1'), 'FOO')).toBe('1');
        });

        it('does not mistake a name that merely starts with `export` for the prefix', () => {
            // `EXPORT` is a name, and only `export` followed by whitespace is the
            // prefix. The lowercase case is the discriminating one: if the prefix
            // HAD been stripped, the name would be `FOO` — perfectly valid — and it
            // would have been accepted. It is refused as an invalid name instead,
            // which is the proof that nothing was stripped (names are uppercase,
            // FR-18).
            expect(parseOk('EXPORT=1').entries).toEqual([{ name: 'EXPORT', value: '1', line: 1 }]);
            expect(parseOk('exportFOO=1').entries).toHaveLength(0);
            expect(parseOk('exportFOO=1').refused[0].reason).toBe('invalidName');
        });

        it('takes single-quoted values literally', () => {
            expect(valueOf(parseOk(String.raw`A='p@ss word #1'`), 'A')).toBe('p@ss word #1');
            expect(valueOf(parseOk(String.raw`A='\n\t\\'`), 'A')).toBe(String.raw`\n\t\\`);
            expect(valueOf(parseOk(`A='  spaced  '`), 'A')).toBe('  spaced  ');
        });

        it('resolves the four double-quote escapes and keeps an unknown one verbatim', () => {
            expect(valueOf(parseOk(String.raw`A="a\nb\tc\rd\"e\\f"`), 'A')).toBe('a\nb\tc\rd"e\\f');
            // A Windows path is the reason unknown escapes keep both characters:
            // `\U` is not an escape, and resolving it to `U` would corrupt it.
            expect(valueOf(parseOk(String.raw`A="C:\Users\x"`), 'A')).toBe(String.raw`C:\Users\x`);
        });

        it('lets a double-quoted value span lines, and keeps the line counter honest', () => {
            const result = parseOk('A="first\nsecond"\nB=after\n');
            expect(result.entries).toEqual([
                { name: 'A', value: 'first\nsecond', line: 1 },
                { name: 'B', value: 'after', line: 3 },
            ]);
            expect(result.lines).toBe(3);
        });

        it('treats a backslash before a line break as a continuation', () => {
            expect(valueOf(parseOk('A="one\\\ntwo"\n'), 'A')).toBe('onetwo');
        });

        it('ends an unquoted value at an inline ` #` comment, and only there', () => {
            expect(valueOf(parseOk('A=value # comment'), 'A')).toBe('value');
            expect(valueOf(parseOk('A=value\t# comment'), 'A')).toBe('value');
            // No whitespace before the `#`: it is part of the value, which is what
            // a password containing `#` needs.
            expect(valueOf(parseOk('A=a#b'), 'A')).toBe('a#b');
            expect(valueOf(parseOk('A="quoted" # comment'), 'A')).toBe('quoted');
        });

        it('trims the name and an unquoted value, and accepts an empty value', () => {
            expect(parseOk('A = 1').entries).toEqual([{ name: 'A', value: '1', line: 1 }]);
            expect(parseOk('   A=1').entries).toEqual([{ name: 'A', value: '1', line: 1 }]);
            expect(parseOk('A=').entries).toEqual([{ name: 'A', value: '', line: 1 }]);
            expect(parseOk('A=   ').entries).toEqual([{ name: 'A', value: '', line: 1 }]);
        });

        it('skips blank lines and `#` comments without reporting them', () => {
            const result = parseOk('# a comment\n\n   \t\nA=1\n');
            expect(result.entries).toEqual([{ name: 'A', value: '1', line: 4 }]);
            expect(result.refused).toHaveLength(0);
            expect(result.lines).toBe(4);
        });

        it('strips a BOM and accepts CRLF and a lone CR as line breaks', () => {
            expect(parseOk('\uFEFFA=1').entries).toEqual([{ name: 'A', value: '1', line: 1 }]);
            expect(parseOk('A=1\r\nB=2\r\n').entries).toEqual([
                { name: 'A', value: '1', line: 1 },
                { name: 'B', value: '2', line: 2 },
            ]);
            expect(parseOk('A=1\rB=2').entries).toEqual([
                { name: 'A', value: '1', line: 1 },
                { name: 'B', value: '2', line: 2 },
            ]);
            // The CR of a CRLF inside a multi-line value is normalised away too,
            // so a value copied from Windows does not carry a stray `\r`.
            expect(valueOf(parseOk('A="x\r\ny"'), 'A')).toBe('x\ny');
        });

        it('answers an empty paste and a non-string with an empty result', () => {
            // The argument can be a JSON body's `import` field, which an HTTP
            // layer may hand over as `undefined`; the parser answers rather than
            // throwing from inside the scanner.
            for (const input of ['', undefined, null] as unknown as string[]) {
                const result = parseOk(input);
                expect(result.entries).toHaveLength(0);
                expect(result.refused).toHaveLength(0);
                expect(result.lines).toBe(0);
            }
        });
    });

    describe('FR-29 — refusals, duplicates and the line each one belongs to', () => {
        it('refuses a line with no `=` at all as malformed', () => {
            // Distinct from the fixture's line 7: with no `=` there is no name to
            // judge, so the answer is the structural one.
            expect(parseOk('this line is not a NAME=value line').refused).toEqual([
                {
                    line: 1,
                    reason: 'invalidName',
                    message: `Line 1 doesn't start with a valid environment variable name (names match ${APP_ENV_NAME_PATTERN}).`,
                },
            ]);
            expect(parseOk('no equals sign here').refused).toEqual([
                {
                    line: 1,
                    reason: 'malformedLine',
                    message: "Line 1 isn't a `NAME=value` line.",
                },
            ]);
        });

        it('refuses a name that fails the grammar of FR-18', () => {
            for (const paste of ['bad-name=1', '=1', '1A=1']) {
                const result = parseOk(paste);
                expect(result.entries).toHaveLength(0);
                expect(result.refused[0].reason).toBe('invalidName');
                expect(result.refused[0].message).toContain(APP_ENV_NAME_PATTERN);
            }
        });

        it('accepts a 128-character name and refuses a 129-character one', () => {
            const longest = `A${'B'.repeat(127)}`;
            expect(longest).toHaveLength(128);
            expect(parseOk(`${longest}=1`).entries).toHaveLength(1);
            expect(parseOk(`${longest}C=1`).refused[0].reason).toBe('invalidName');
        });

        it('refuses a reserved name, and reports the grammar first when both apply', () => {
            const reserved = parseOk(`${APP_ENV_RESERVED_PREFIX}X=1`);
            expect(reserved.entries).toHaveLength(0);
            expect(reserved.refused[0].reason).toBe('reservedName');
            expect(reserved.refused[0].message).toContain(APP_ENV_RESERVED_PREFIX);

            // `EVER_WORKS-bad` breaks the grammar AND the prefix; the grammar is
            // the one the member has to fix first, so that is what they are told
            // (the same precedence `validateAppEnvValue` applies, plan §4.4:406).
            expect(parseOk(`${APP_ENV_RESERVED_PREFIX}bad-name=1`).refused[0].reason).toBe(
                'invalidName',
            );
        });

        it('refuses an unterminated quote, at the line it opened on', () => {
            expect(parseOk('A="x').refused).toEqual([
                { line: 1, reason: 'malformedLine', message: "Line 1 isn't a `NAME=value` line." },
            ]);

            // A single-quoted value does NOT span lines (FR-28 grants that to
            // double quotes only). The physical remainder is a line of its own and
            // is refused on its own line — nothing is silently swallowed, which is
            // exactly what the second refusal below pins. The line AFTER the bad
            // one is asserted too, so a scanner that lost its place is caught here
            // rather than by the member reading the wrong line number.
            const single = parseOk("A='x\ny'\nB=1\n");
            expect(single.refused.map((refusal) => refusal.line)).toEqual([1, 2]);
            expect(single.refused.every((refusal) => refusal.reason === 'malformedLine')).toBe(
                true,
            );
            expect(single.entries).toEqual([{ name: 'B', value: '1', line: 3 }]);
        });

        it('refuses trailing junk after a closing quote, without losing the next line', () => {
            // The closing quote may sit on a LATER line than the value started on;
            // the resume point must be computed from the closing quote, not from
            // the line the value opened on. A resumption point that pointed back at
            // line 1 would make the scanner re-read the same input forever.
            const result = parseOk('A="x\ny" junk\nB=1\n');
            expect(result.refused.map((refusal) => refusal.line)).toEqual([1]);
            expect(result.entries).toEqual([{ name: 'B', value: '1', line: 3 }]);
        });

        it('refuses a backslash that ends the paste', () => {
            expect(parseOk('A="x\\').refused[0].reason).toBe('malformedLine');
        });

        it('keeps the last value of a duplicated name and reports the earlier line', () => {
            const result = parseOk('A=1\nB=2\nA=3\n');
            // The winning value is what reaches the app; the entry keeps the
            // POSITION of the first occurrence, so the list still reads in the
            // order the member wrote their names, while `line` names the line the
            // stored value actually came from.
            expect(result.entries).toEqual([
                { name: 'A', value: '3', line: 3 },
                { name: 'B', value: '2', line: 2 },
            ]);
            expect(result.duplicates).toEqual([{ line: 1, name: 'A', winnerLine: 3 }]);
        });

        it('reports a name that appeared three times as two skipped lines', () => {
            const result = parseOk('A=1\nA=2\nA=3\n');
            expect(result.entries).toEqual([{ name: 'A', value: '3', line: 3 }]);
            expect(result.duplicates).toEqual([
                { line: 1, name: 'A', winnerLine: 3 },
                { line: 2, name: 'A', winnerLine: 3 },
            ]);
        });

        it('accounts for every value line exactly once, so nothing is silently dropped', () => {
            const result = parseOk('# comment\nA=1\nbad-name=2\nA=4\n\nB=5\n');
            const accounted =
                result.entries.length + result.duplicates.length + result.refused.length;
            // Six lines: one comment and one blank leave no trace; the other four
            // are one refusal, one duplicate and two entries.
            expect(accounted).toBe(4);
            expect(result.lines).toBe(6);
        });
    });

    describe('plan §4.5:420 — the two limits, checked before parsing', () => {
        it('accepts exactly 65,536 bytes and refuses one byte more', () => {
            const atLimit = `A=${'x'.repeat(APP_ENV_DOTENV_MAX_BYTES - 2)}`;
            expect(Buffer.byteLength(atLimit, 'utf8')).toBe(APP_ENV_DOTENV_MAX_BYTES);
            expect(parseOk(atLimit).entries[0].value).toHaveLength(APP_ENV_DOTENV_MAX_BYTES - 2);

            const overLimit = `A=${'x'.repeat(APP_ENV_DOTENV_MAX_BYTES - 1)}`;
            expect(Buffer.byteLength(overLimit, 'utf8')).toBe(APP_ENV_DOTENV_MAX_BYTES + 1);
            const refusal = limited(parseAppEnvDotenv(overLimit));
            expect(refusal.code).toBe('valuesTooLarge');
            expect(refusal.limit).toBe(APP_ENV_DOTENV_MAX_BYTES);
            expect(refusal.actual).toBe(APP_ENV_DOTENV_MAX_BYTES + 1);
        });

        it('accepts exactly 500 lines and refuses 501', () => {
            const atLimit = lines(APP_ENV_DOTENV_MAX_LINES);
            expect(parseOk(atLimit).entries).toHaveLength(APP_ENV_DOTENV_MAX_LINES);

            const overLimit = lines(APP_ENV_DOTENV_MAX_LINES + 1);
            const refusal = limited(parseAppEnvDotenv(overLimit));
            expect(refusal.code).toBe('tooManyValues');
            expect(refusal.limit).toBe(APP_ENV_DOTENV_MAX_LINES);
            expect(refusal.actual).toBe(APP_ENV_DOTENV_MAX_LINES + 1);
        });

        it('parses nothing at all when a limit is exceeded', () => {
            // The proof that the check runs BEFORE parsing: this paste's first line
            // is malformed, so a parser that had started would have a refusal to
            // report. The answer is the limit, with no partial result to store.
            const overLimit = ['this line is not a NAME=value line', ...lines(500)].join('\n');
            const refusal = limited(parseAppEnvDotenv(overLimit));
            expect(refusal.code).toBe('tooManyValues');
            expect(Object.keys(refusal).sort()).toEqual([
                'actual',
                'code',
                'kind',
                'limit',
                'message',
                'ok',
            ]);
        });

        it('checks the byte ceiling before the line ceiling', () => {
            // A paste over both limits has no line to blame for its size either
            // way; the byte ceiling is the one that is knowable without splitting
            // the text, so it is the one answered.
            const both = lines(APP_ENV_DOTENV_MAX_LINES + 1) + 'X'.repeat(APP_ENV_DOTENV_MAX_BYTES);
            expect(limited(parseAppEnvDotenv(both)).code).toBe('valuesTooLarge');
        });

        it('names the limit and the actual size, and never a value', () => {
            const refusal = limited(parseAppEnvDotenv(lines(APP_ENV_DOTENV_MAX_LINES + 1)));
            expect(refusal.message).toContain('501');
            expect(refusal.message).toContain(String(APP_ENV_DOTENV_MAX_LINES));
        });

        it('keeps the value ceiling reachable-only-if-the-paste-ceiling-moves', () => {
            // See the file docstring: while the paste ceiling is at or below the
            // value ceiling, no parsed value can exceed the latter, so the
            // `valueTooLarge` branch inside a quoted value cannot execute. Raising
            // the paste ceiling fails here, which is the reminder to revisit it.
            expect(APP_ENV_DOTENV_MAX_BYTES).toBeLessThanOrEqual(APP_ENV_VALUE_MAX_BYTES);

            // …and the largest paste that is legal really does not trip it.
            const biggest = `A="${'x'.repeat(APP_ENV_DOTENV_MAX_BYTES - 4)}"`;
            expect(Buffer.byteLength(biggest, 'utf8')).toBe(APP_ENV_DOTENV_MAX_BYTES);
            const result = parseOk(biggest);
            expect(result.refused).toHaveLength(0);
            expect(result.entries[0].value).toHaveLength(APP_ENV_DOTENV_MAX_BYTES - 4);
        });
    });

    describe('FR-30 — the paste is never logged and never echoed', () => {
        const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
        const spies = methods.map((method) => jest.spyOn(console, method));

        afterAll(() => {
            for (const spy of spies) {
                spy.mockRestore();
            }
        });

        beforeEach(() => {
            for (const spy of spies) {
                spy.mockClear();
            }
        });

        it('calls no console method for any of the shapes a member can paste', () => {
            for (const spy of spies) {
                spy.mockImplementation(() => undefined);
            }
            parseAppEnvDotenv(FIXTURE);
            parseAppEnvDotenv('bad-name=1\nA="unterminated\nB=2');
            parseAppEnvDotenv(lines(APP_ENV_DOTENV_MAX_LINES + 1));
            parseAppEnvDotenv(`${APP_ENV_RESERVED_PREFIX}X=1`);
            for (const spy of spies) {
                expect(spy).not.toHaveBeenCalled();
            }
        });

        it('has no logger in its source', () => {
            const source = readFileSync(join(__dirname, '..', 'dotenv-parser.ts'), 'utf8');
            // Comments first: this file's own docstring explains the rule and
            // therefore names it, and the check is about the code
            // (`generators.spec.ts:530-539` does the same for FR-11).
            const code = source
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
            expect(code).not.toMatch(/\bconsole\s*\./);
            expect(code).not.toMatch(/\blogger\b/i);
            expect(code).not.toMatch(/from '@ever-works\/logger'/);
        });

        it('never puts a name or a value in a refusal message', () => {
            const secret = 'sup3r-s3cret-value-9';
            const name = 'MISSING_NAME';
            const result = parseOk(
                [
                    `${name}=${secret}`,
                    `bad-name=${secret}`,
                    `${APP_ENV_RESERVED_PREFIX}X=${secret}`,
                    `no-equals-${secret}`,
                ].join('\n'),
            );

            expect(result.refused).toHaveLength(3);
            for (const refusal of result.refused) {
                expect(refusal.message).not.toContain(secret);
                expect(refusal.message).not.toContain(name);
                expect(refusal.message).not.toContain('bad-name');
                expect(refusal.message).toMatch(/^Line \d/);
            }
            // A refusal row has no field a value could travel in.
            expect(Object.keys(result.refused[0]).sort()).toEqual(['line', 'message', 'reason']);
            // …while the accepted value IS returned, which is the whole point of
            // parsing: the parser does not redact, it just does not echo.
            expect(result.entries).toEqual([{ name, value: secret, line: 1 }]);
        });
    });
});

/**
 * The result types are consumed by T13's service, so their shape is pinned here
 * as types rather than only as runtime values: a field renamed in the parser
 * fails `tsc` in this file instead of in whichever caller happens to be compiled
 * next.
 */
describe('AppEnv .env parser — the frozen API (T13 consumes it)', () => {
    it('answers a discriminated union whose parsed arm carries the four collections', () => {
        const result = parseAppEnvDotenv('A=1');
        if (result.kind !== 'parsed') {
            throw new Error('expected a parsed result');
        }
        const entries: readonly AppEnvDotenvEntry[] = result.entries;
        const refused: readonly AppEnvDotenvRefusal[] = result.refused;
        expect(entries).toHaveLength(1);
        expect(refused).toHaveLength(0);
        expect(result.lines).toBe(1);
        expect(result.duplicates).toHaveLength(0);
        expect(result.ok).toBe(true);
    });

    it('discriminates on `kind`, which narrows even without strictNullChecks', () => {
        const overLimit = parseAppEnvDotenv(lines(APP_ENV_DOTENV_MAX_LINES + 1));
        if (overLimit.kind !== 'limits') {
            throw new Error('expected the line-limit answer');
        }
        expect(overLimit.ok).toBe(false);
        expect(overLimit.code).toBe('tooManyValues');
    });

    it('types every refusal reason as an existing contract code', () => {
        const reasons: readonly AppEnvDotenvRefusal['reason'][] = [
            'malformedLine',
            'invalidName',
            'reservedName',
            'valueTooLarge',
        ];
        const result = parseOk(reasons.map((_, index) => `bad-name-${index}=1`).join('\n'));
        expect(result.refused.every((refusal) => refusal.reason === 'invalidName')).toBe(true);
    });
});
