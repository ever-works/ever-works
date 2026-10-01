import {
    APP_ENV_DOTENV_MAX_BYTES,
    APP_ENV_DOTENV_MAX_LINES,
    APP_ENV_NAME_PATTERN,
    APP_ENV_RESERVED_PREFIX,
    APP_ENV_VALUE_MAX_BYTES,
    type AppEnvApiErrorCode,
    type AppEnvErrorCode,
} from '@ever-works/contracts';

/**
 * APW-07 (App env & dependencies) — the `.env` import parser, plan §4.5
 * (`plan.md:413-420`).
 *
 * Spec: FR-28 (`spec.md:283-285`, what the paste grammar accepts), FR-29
 * (`spec.md:286-288`, one outcome per line, a refusal carries its line number),
 * FR-30 (`spec.md:289-290`, the pasted text is never stored, logged or echoed),
 * ACC-07-11 (`spec.md:590-591`). Plan §4.5 fixes the shape and the limits; the
 * caller is `AppEnvService.apply`'s `import` branch (T13, plan §4.2:367-372),
 * which turns this parser's per-line answer into the route's `results[]`
 * (`plan.md:785`).
 *
 * ## A state machine, not a regex (`plan.md:415`)
 *
 * The plan says so explicitly, and the reason is that the three value forms are
 * not a regular language once a double-quoted value may span lines: the scanner
 * below walks one character at a time and knows exactly which state it is in.
 * A regex would either have to be anchored per line — which cannot express
 * "until the closing quote, possibly on a later line" — or would need a lazy
 * `[\s\S]*?` with backtracking, on input an unauthenticated member can paste.
 *
 * ## Nothing here is stored, logged or echoed (FR-30)
 *
 * The module has no logger, no `console` call and no module-level mutable state:
 * every value lives in the returned object and dies with the caller's stack. That
 * is asserted two ways in `__tests__/dotenv-parser.spec.ts` — spies on all five
 * `console` methods, and a scan of this file's own source for `console.` /
 * `logger`. A refusal's `message` names the **line** and the rule and never the
 * name or the value: the paste is member input that may hold a production
 * password, and the member-facing copy for each refusal is the route's job
 * (`dashboard.workDetail.appEnv.errors.*`, plan §8:907), where the service knows
 * which entry it belongs to.
 *
 * ## The two pre-parse limits (`plan.md:420`)
 *
 * "Limits 64 KiB / 500 lines checked before parsing." Both are answers of their
 * own ({@link AppEnvDotenvLimits}) rather than rows in `refused`, because a paste
 * that is too big has no line to blame and must not be half-applied: a caller
 * handed a partial `entries` list for an oversized paste would store part of it
 * and report success. Both codes are **existing** members of
 * `APP_ENV_API_ERROR_CODES` — `valuesTooLarge` for the byte ceiling,
 * `tooManyValues` for the line ceiling — so the route answers 422 with copy it
 * already has. A new code here would be a member-facing error with no message
 * key, which is exactly what G23 forbids.
 *
 * ## Duplicates (`plan.md:419`)
 *
 * "duplicates → last wins, earlier `skipped duplicate`." The winning value is the
 * one that reaches the app, so `entries` carries it; the superseded occurrences
 * are kept in `duplicates` **with their line numbers**, because FR-29 requires a
 * member to be told which line was skipped, and a parser that dropped them would
 * leave the service unable to say. `entries` keeps the position of a name's first
 * occurrence, so the list reads in the order the member wrote it, while `line` is
 * the line the winning value actually came from.
 *
 * ## What this parser deliberately does NOT refuse
 *
 * `lengthMismatch`, `tooShort`, `tooLong`, `patternMismatch` and
 * `controlCharacter` need the App spec's per-entry rules, which this module never
 * sees — they belong to `validateAppEnvValue` (`./validation.ts`, plan §4.4),
 * which the service calls per entry. The split is by knowledge, not by
 * convenience: a NUL inside a value is refused by validation even when the line
 * parsed perfectly, and a line refused here never reaches it.
 */

/** The name grammar of FR-18, compiled once from the contract's own string. */
const NAME_PATTERN = new RegExp(APP_ENV_NAME_PATTERN);

/** A byte-order mark, stripped before anything else (`plan.md:415`). */
const BOM = '\uFEFF';

/** The per-line refusal reasons this parser produces. */
export type AppEnvDotenvLineRefusalReason = Extract<
    AppEnvErrorCode,
    'malformedLine' | 'invalidName' | 'reservedName' | 'valueTooLarge'
>;

/**
 * The pre-parse limit codes — both existing `AppEnvApiErrorCode`s.
 *
 * The `Extract` is the point: each member is provably a code the contracts
 * export, so a refusal can never name an error the route has no copy for.
 */
export type AppEnvDotenvLimitCode = Extract<AppEnvApiErrorCode, 'tooManyValues' | 'valuesTooLarge'>;

/** One `NAME=value` line the import may store (FR-28). */
export interface AppEnvDotenvEntry {
    /** The name as written (trimmed), already known to match `APP_ENV_NAME_PATTERN`. */
    readonly name: string;
    /** The value with its quoting removed and its escapes resolved. */
    readonly value: string;
    /** The 1-based line the value was read from — the line of the **last** occurrence. */
    readonly line: number;
}

/** One line the import refuses, with the line number FR-29 requires. */
export interface AppEnvDotenvRefusal {
    /** The 1-based line the refusal belongs to. */
    readonly line: number;
    readonly reason: AppEnvDotenvLineRefusalReason;
    /**
     * A line-scoped sentence naming the rule.
     *
     * Never contains the name or the value: this string can travel (into a
     * response, into a log written by a caller, into a test failure) and FR-30
     * forbids the paste leaving this module in any form other than the returned
     * values themselves.
     */
    readonly message: string;
}

/**
 * An earlier occurrence of a name that appeared more than once
 * (`plan.md:419`) — the FR-29 `skipped` line.
 */
export interface AppEnvDotenvDuplicate {
    /** The superseded line. */
    readonly line: number;
    readonly name: string;
    /** The line whose value won and is the one in `entries`. Always later than `line`. */
    readonly winnerLine: number;
}

/** A paste that exceeded a pre-parse limit and was therefore not parsed at all. */
export interface AppEnvDotenvLimits {
    /**
     * The discriminant a caller switches on.
     *
     * A **string** literal, not only {@link AppEnvDotenvLimits.ok}, because this
     * package compiles with `strictNullChecks: false` (`tsconfig.json`), which
     * widens a `true`/`false` property to `boolean` — and a `boolean`
     * discriminant does not narrow. Narrowing on `kind` works in every consumer,
     * including the ones that would otherwise need a cast.
     */
    readonly kind: 'limits';
    readonly ok: false;
    readonly code: AppEnvDotenvLimitCode;
    /** The ceiling that was exceeded, from the contracts' constants. */
    readonly limit: number;
    /** What the paste actually was — bytes, or logical lines. */
    readonly actual: number;
    /** A sentence naming the limit and the actual size. No line and no value: nothing was parsed. */
    readonly message: string;
}

/** The answer for a paste that was parsed. */
export interface AppEnvDotenvParsed {
    /** The discriminant a caller switches on — see {@link AppEnvDotenvLimits.kind}. */
    readonly kind: 'parsed';
    readonly ok: true;
    /**
     * One row per distinct name, in the order of its **first** occurrence, each
     * carrying the value and line of its **last** (see the docstring).
     */
    readonly entries: readonly AppEnvDotenvEntry[];
    /** Every refused line, in line order. */
    readonly refused: readonly AppEnvDotenvRefusal[];
    /** Every superseded duplicate, in line order. */
    readonly duplicates: readonly AppEnvDotenvDuplicate[];
    /** The number of logical lines after BOM and CRLF normalisation. */
    readonly lines: number;
}

/** What {@link parseAppEnvDotenv} answers. */
export type AppEnvDotenvParseResult = AppEnvDotenvParsed | AppEnvDotenvLimits;

/** One occurrence of a name, before duplicates are resolved. */
interface Occurrence {
    readonly name: string;
    readonly value: string;
    readonly line: number;
}

/** What one logical line turned out to be. */
type LineOutcome =
    | { readonly kind: 'blank' }
    | { readonly kind: 'refusal'; readonly reason: AppEnvDotenvLineRefusalReason }
    | { readonly kind: 'entry'; readonly name: string; readonly value: string };

/**
 * What a value scan produced — the same outcomes as a line, minus the name.
 *
 * The value scanner runs before the name is known to be valid, so it cannot
 * return a `LineOutcome`; {@link scanLine} adds the name once it has one. Keeping
 * the two shapes separate is what lets `scanValue` refuse a value without
 * inventing a name it does not have.
 */
type ValueOutcome =
    | { readonly kind: 'refusal'; readonly reason: AppEnvDotenvLineRefusalReason }
    | { readonly kind: 'value'; readonly value: string };

/**
 * One scanned logical line, plus where the scanner resumes.
 *
 * Every `next` below is computed as "past the next line break at or after where
 * the scanner stopped", which is strictly greater than the index the line started
 * at. The loop in {@link parseAppEnvDotenv} depends on that: a resumption point at
 * or before the start would re-scan the same line forever, so the loop asserts the
 * progress rather than trusting it.
 */
interface LineScan {
    /** The index just past this logical line — past its `\n` when it had one. */
    readonly next: number;
    /** The `\n` characters this logical line swallowed — `1`, or more inside a multi-line value. */
    readonly newlines: number;
    readonly outcome: LineOutcome;
}

/** One scanned value, plus where the scanner resumes. */
interface ValueScan {
    readonly next: number;
    readonly newlines: number;
    readonly outcome: ValueOutcome;
}

/**
 * Parse pasted `.env` text (FR-28).
 *
 * Answers rather than throws for every shape of member input, including input
 * that is not text at all: an empty paste is an empty result, and a paste over
 * either limit is a {@link AppEnvDotenvLimits}. The one thing it will not do is
 * parse part of an oversized paste — see the module docstring.
 */
export function parseAppEnvDotenv(text: string): AppEnvDotenvParseResult {
    // A caller that hands over a non-string (a JSON body with `import: {}`, a
    // form field that arrived as an array) gets the same answer as an empty paste
    // rather than a `TypeError` from deep inside the scanner. This is the only
    // place the argument's type is looked at.
    const source = typeof text === 'string' ? text : '';

    // The limits come first and from the RAW text: normalising a 10 MB string in
    // order to count its lines would be the work the ceiling exists to avoid
    // (`plan.md:420`, "checked before parsing").
    const bytes = Buffer.byteLength(source, 'utf8');
    if (bytes > APP_ENV_DOTENV_MAX_BYTES) {
        return limitRefusal('valuesTooLarge', APP_ENV_DOTENV_MAX_BYTES, bytes);
    }

    const normalized = normalizeNewlines(stripBom(source));
    const lines = countLines(normalized);
    if (lines > APP_ENV_DOTENV_MAX_LINES) {
        return limitRefusal('tooManyValues', APP_ENV_DOTENV_MAX_LINES, lines);
    }

    const occurrences: Occurrence[] = [];
    const refused: AppEnvDotenvRefusal[] = [];

    let cursor = 0;
    let lineNumber = 1;
    while (cursor < normalized.length) {
        const scan = scanLine(normalized, cursor);
        if (scan.outcome.kind === 'entry') {
            occurrences.push({
                name: scan.outcome.name,
                value: scan.outcome.value,
                line: lineNumber,
            });
        } else if (scan.outcome.kind === 'refusal') {
            refused.push({
                line: lineNumber,
                reason: scan.outcome.reason,
                message: refusalMessage(lineNumber, scan.outcome.reason),
            });
        }
        // The guarantee every `next` above is built to keep: always forward.
        cursor = scan.next > cursor ? scan.next : normalized.length;
        // `newlines` counts every `\n` this logical line swallowed, its own
        // terminator included, so the next line's number is this many further on.
        lineNumber += scan.newlines;
    }

    const resolved = resolveDuplicates(occurrences);
    return {
        kind: 'parsed',
        ok: true,
        entries: resolved.entries,
        refused,
        duplicates: resolved.duplicates,
        lines,
    };
}

/**
 * One entry per distinct name (the last value wins) plus the superseded
 * occurrences (`plan.md:419`).
 *
 * Two passes over a list of at most 500 rows: the first records each name's
 * **last** occurrence and the order the names were first seen, the second emits
 * the entries in that order and every superseded occurrence as a duplicate.
 */
function resolveDuplicates(occurrences: readonly Occurrence[]): {
    readonly entries: AppEnvDotenvEntry[];
    readonly duplicates: AppEnvDotenvDuplicate[];
} {
    const firstSeen: string[] = [];
    const winners = new Map<string, Occurrence>();
    for (const occurrence of occurrences) {
        if (!winners.has(occurrence.name)) {
            firstSeen.push(occurrence.name);
        }
        // Last wins (`plan.md:419`).
        winners.set(occurrence.name, occurrence);
    }

    const entries: AppEnvDotenvEntry[] = firstSeen.map((name) => {
        const winner = winners.get(name) as Occurrence;
        return { name, value: winner.value, line: winner.line };
    });

    const duplicates: AppEnvDotenvDuplicate[] = [];
    for (const occurrence of occurrences) {
        const winner = winners.get(occurrence.name) as Occurrence;
        if (winner.line !== occurrence.line) {
            duplicates.push({
                line: occurrence.line,
                name: occurrence.name,
                winnerLine: winner.line,
            });
        }
    }

    return { entries, duplicates };
}

/**
 * Strip one leading BOM (`plan.md:415`). Only at offset 0: a `\uFEFF` inside the
 * text is a zero-width no-break space in a value, not a marker.
 */
function stripBom(source: string): string {
    return source.startsWith(BOM) ? source.slice(BOM.length) : source;
}

/**
 * `\r\n` → `\n`, and a lone `\r` → `\n` (`plan.md:415`).
 *
 * The plan names `\r\n`; a lone `\r` is normalised too because the alternative is
 * treating a Classic-Mac file as ONE line, which would be refused as malformed
 * with a line number of 1 and no way for the member to see why. Both are line
 * breaks to every editor the member could have copied from.
 */
function normalizeNewlines(source: string): string {
    return source.replace(/\r\n?/g, '\n');
}

/**
 * The number of logical lines: one per `\n`, plus one for a final line with no
 * trailing newline. An empty paste has none.
 */
function countLines(normalized: string): number {
    if (normalized.length === 0) {
        return 0;
    }
    let count = 0;
    for (let index = 0; index < normalized.length; index += 1) {
        if (normalized[index] === '\n') {
            count += 1;
        }
    }
    return normalized.endsWith('\n') ? count : count + 1;
}

/** Build the {@link AppEnvDotenvLimits} answer for one exceeded ceiling. */
function limitRefusal(
    code: AppEnvDotenvLimitCode,
    limit: number,
    actual: number,
): AppEnvDotenvLimits {
    const subject = code === 'valuesTooLarge' ? 'bytes' : 'lines';
    return {
        kind: 'limits',
        ok: false,
        code,
        limit,
        actual,
        message: `The pasted text has ${actual} ${subject}, more than the ${limit} allowed.`,
    };
}

/**
 * The sentence for one refused line.
 *
 * Line-scoped and value-free on purpose (FR-30): the only number it names is the
 * line the member can point at in their editor.
 */
function refusalMessage(line: number, reason: AppEnvDotenvLineRefusalReason): string {
    switch (reason) {
        case 'malformedLine':
            return `Line ${line} isn't a \`NAME=value\` line.`;
        case 'invalidName':
            return `Line ${line} doesn't start with a valid environment variable name (names match ${APP_ENV_NAME_PATTERN}).`;
        case 'reservedName':
            return `Line ${line} uses \`${APP_ENV_RESERVED_PREFIX}\`, which is reserved for Ever Works.`;
        case 'valueTooLarge':
            return `Line ${line} has a value larger than ${APP_ENV_VALUE_MAX_BYTES} bytes.`;
    }
}

/**
 * Scan one logical line, starting at `start` (the index of its first character).
 *
 * `start` is always `0` or the index just past a `\n`, so the line number the
 * caller tracks is the number of newlines consumed before it, plus one. Every
 * index here is **absolute** into `text` rather than relative to a trimmed slice:
 * a double-quoted value may run past the end of this line, and an offset that had
 * been computed against a trimmed copy would point at the wrong character.
 */
function scanLine(text: string, start: number): LineScan {
    const lineEnd = text.indexOf('\n', start);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const next = lineEnd === -1 ? text.length : lineEnd + 1;
    const lineNewlines = lineEnd === -1 ? 0 : 1;

    // Blank and `#` comment lines (FR-28) leave no trace: the plan's result shape
    // has no field for them, and neither is an outcome a member needs told.
    const afterIndent = skipHorizontalWhitespace(text, start, end);
    if (afterIndent >= end || text[afterIndent] === '#') {
        return { next, newlines: lineNewlines, outcome: { kind: 'blank' } };
    }

    const bodyStart = skipExportPrefix(text, afterIndent, end);
    const equals = text.indexOf('=', bodyStart);
    if (equals === -1 || equals >= end) {
        return {
            next,
            newlines: lineNewlines,
            outcome: { kind: 'refusal', reason: 'malformedLine' },
        };
    }

    // The name is trimmed (`plan.md:416`), so `FOO =1` is `FOO`.
    const name = trimHorizontal(text.slice(bodyStart, equals));
    if (!NAME_PATTERN.test(name)) {
        // The same order as `validateAppEnvValue` (plan §4.4:406): the grammar
        // first, then the reserved prefix, so a name that is both invalid and
        // reserved is reported as the grammar error the member fixes first.
        return {
            next,
            newlines: lineNewlines,
            outcome: { kind: 'refusal', reason: 'invalidName' },
        };
    }
    if (name.startsWith(APP_ENV_RESERVED_PREFIX)) {
        return {
            next,
            newlines: lineNewlines,
            outcome: { kind: 'refusal', reason: 'reservedName' },
        };
    }

    const value = scanValue(text, equals + 1, end, next, lineNewlines);
    if (value.outcome.kind === 'refusal') {
        // Rebuilt rather than returned as-is: `value` is a `ValueScan`, whose
        // outcome union still holds its `value` arm, so it is not assignable to a
        // `LineScan` even after this guard.
        return {
            next: value.next,
            newlines: value.newlines,
            outcome: { kind: 'refusal', reason: value.outcome.reason },
        };
    }
    return {
        next: value.next,
        newlines: value.newlines,
        outcome: { kind: 'entry', name, value: value.outcome.value },
    };
}

/**
 * Read the value starting at `valueStart` — one character past the `=`.
 *
 * `lineEnd`, `next` and `lineNewlines` describe the line as it was found; a
 * double-quoted value may run past all three, which is why they are parameters
 * rather than recomputed here.
 */
function scanValue(
    text: string,
    valueStart: number,
    lineEnd: number,
    next: number,
    lineNewlines: number,
): ValueScan {
    const index = skipHorizontalWhitespace(text, valueStart, lineEnd);

    const quote = index < lineEnd ? text[index] : undefined;
    if (quote === '"' || quote === "'") {
        return scanQuotedValue(text, index, quote, next, lineNewlines);
    }

    // Unquoted: to the end of the line, stopped at an inline ` #` comment
    // (`plan.md:416`), then trimmed.
    return {
        next,
        newlines: lineNewlines,
        outcome: { kind: 'value', value: trimUnquotedValue(text.slice(index, lineEnd)) },
    };
}

/**
 * A quoted value.
 *
 * Double quotes resolve `\n`, `\t`, `\"` and `\\` and may span lines
 * (`plan.md:417-418`); single quotes are literal up to the closing quote (FR-28).
 * An unknown `\x` inside double quotes keeps both characters: refusing it would
 * break a Windows path or a regex a member wrote correctly, and resolving it to a
 * bare `x` would silently change their value.
 */
function scanQuotedValue(
    text: string,
    quoteStart: number,
    quote: string,
    lineNext: number,
    lineNewlines: number,
): ValueScan {
    const double = quote === '"';
    let index = quoteStart + 1;
    let value = '';
    let newlines = 0;

    while (index < text.length) {
        const character = text[index];

        if (double && character === '\\') {
            const escaped = text[index + 1];
            if (escaped === undefined) {
                // A trailing backslash at the very end of the paste.
                return malformed(text.length, newlines);
            }
            if (escaped === '\n') {
                // A backslash immediately before a line break is a continuation:
                // the break is consumed and the value keeps going without it.
                newlines += 1;
                index += 2;
                continue;
            }
            value += resolveEscape(escaped);
            index += 2;
            continue;
        }

        if (character === quote) {
            // `plan.md:418`: after the closing quote, only spaces and a comment
            // may follow. The remainder is read to the end of the CLOSING quote's
            // line, which may be several lines below where the value started.
            const breakAt = text.indexOf('\n', index + 1);
            const remainder = trimHorizontal(
                text.slice(index + 1, breakAt === -1 ? text.length : breakAt),
            );
            if (remainder.length > 0 && !remainder.startsWith('#')) {
                return malformed(
                    breakAt === -1 ? text.length : breakAt + 1,
                    newlines + (breakAt === -1 ? 0 : 1),
                );
            }
            if (Buffer.byteLength(value, 'utf8') > APP_ENV_VALUE_MAX_BYTES) {
                // Unreachable while `APP_ENV_VALUE_MAX_BYTES >= APP_ENV_DOTENV_MAX_BYTES`
                // — unescaping never grows a value and the whole paste is already at
                // or below that ceiling (asserted in the spec, so raising the paste
                // limit fails there rather than silently making this branch live
                // without a test). Kept because plan §4.5:418 states the rule.
                return {
                    next: breakAt === -1 ? text.length : breakAt + 1,
                    newlines: newlines + (breakAt === -1 ? 0 : 1),
                    outcome: { kind: 'refusal', reason: 'valueTooLarge' },
                };
            }
            return {
                next: breakAt === -1 ? text.length : breakAt + 1,
                newlines: newlines + (breakAt === -1 ? 0 : 1),
                outcome: { kind: 'value', value },
            };
        }

        if (character === '\n') {
            if (!double) {
                // Single quotes do not span lines (FR-28 grants that to double
                // quotes only): an unterminated one is a malformed line, and
                // swallowing the rest of the paste would blame the wrong line.
                return malformed(index + 1, newlines + 1);
            }
            newlines += 1;
            value += '\n';
            index += 1;
            continue;
        }

        value += character;
        index += 1;
    }

    // Ran out of input before the closing quote.
    return malformed(text.length, newlines);
}

/**
 * The `malformedLine` answer, resuming at `resume`.
 *
 * `resume` is always past the character the caller was looking at, so the scanner
 * cannot re-enter the same line. `newlines` is what the caller had already
 * swallowed inside this logical line.
 */
function malformed(resume: number, newlines: number): ValueScan {
    return {
        next: resume,
        newlines,
        outcome: { kind: 'refusal', reason: 'malformedLine' },
    };
}

/** The one-character escapes of `plan.md:417`; anything else keeps both characters. */
function resolveEscape(escaped: string): string {
    switch (escaped) {
        case 'n':
            return '\n';
        case 't':
            return '\t';
        case 'r':
            return '\r';
        case '"':
            return '"';
        case '\\':
            return '\\';
        default:
            return `\\${escaped}`;
    }
}

/**
 * An unquoted value: trimmed, and ended by the first whitespace-then-`#`
 * (`plan.md:416`).
 *
 * The `#` must be preceded by whitespace to count — `FOO=a#b` is the literal
 * `a#b`, which is what every dotenv implementation does and what a password
 * containing `#` requires.
 */
function trimUnquotedValue(rest: string): string {
    const commentAt = /[\t ]+#/.exec(rest);
    return trimHorizontal(commentAt ? rest.slice(0, commentAt.index) : rest);
}

/** The index just past an optional `export ` prefix (FR-28), or `from` itself. */
function skipExportPrefix(text: string, from: number, end: number): number {
    const match = /^export[\t ]+/.exec(text.slice(from, end));
    return match ? from + match[0].length : from;
}

/** The first index at or after `from` that is not a space or a tab, capped at `end`. */
function skipHorizontalWhitespace(text: string, from: number, end: number): number {
    let index = from;
    while (index < end && (text[index] === ' ' || text[index] === '\t')) {
        index += 1;
    }
    return index;
}

/** A value with its leading and trailing spaces and tabs removed — never a line break. */
function trimHorizontal(value: string): string {
    return value.replace(/^[\t ]+/, '').replace(/[\t ]+$/, '');
}
