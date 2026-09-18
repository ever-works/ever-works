import { RE2JS } from 're2js';
import {
    APP_ENV_NAME_PATTERN,
    APP_ENV_RESERVED_PREFIX,
    APP_ENV_VALUE_MAX_BYTES,
    type AppEnvValidationRefusalCode,
} from '@ever-works/contracts';

/**
 * APW-07 (App env & dependencies) — value validation, plan §4.4
 * (`plan.md:404-411`).
 *
 * Spec: FR-17 (`spec.md:246-248`, whole-value `pattern` matching, linear time,
 * never longer than 50 ms per value), FR-18 (`spec.md:249-250`, the name
 * grammar, the 65,536-byte ceiling, no NUL, `EVER_WORKS_` reserved), FR-19
 * (`spec.md:251-252`, a message naming the rule and — for length — the actual
 * length, never the value), S15 (`spec.md:154-155`), S16
 * (`spec.md:156-157`). Plan §4.2:367 is the one caller: `AppEnvService.apply`
 * validates every item **before** it is stored, so a refusal here is the last
 * door before `AppEnvCrypto.encrypt` and the repository write.
 *
 * ## The order is the contract (`plan.md:406-411`)
 *
 * name pattern → reserved prefix → byte length ≤ 65,536 **and** no NUL →
 * `length` → `minLength` → `maxLength` (counted in Unicode code points) →
 * `pattern`. The order is not cosmetic: it decides which of two applicable
 * refusals a caller is told about, and a spec that passed the wrong one would
 * send a member to fix the wrong field. Each step below is one `if`, in that
 * order, and `__tests__/validation.spec.ts` asserts the precedence pairs.
 *
 * ## `re2js`, not `RegExp` (FR-17)
 *
 * Patterns come from a repository file and are untrusted, so they are compiled
 * by **RE2** — a linear-time engine with no backtracking, which is what makes
 * "never longer than 50 milliseconds per value" a property rather than a hope.
 * A pattern RE2 cannot run (look-around, back-references) is refused as
 * `patternUnsupported` rather than silently evaluated by `RegExp`, whose
 * catastrophic-backtracking behaviour is exactly the risk FR-17 names. The
 * refusal reuses APW-03's own sentence for the same defect — `pattern_unsupported`
 * at `works-config/schema/app-spec.issues.ts:435-437`, "`…` uses a
 * `validate.pattern` the resolver cannot run." — so the editor and the resolver
 * call one problem by one name.
 *
 * Patterns are compiled as `^(?:<pattern>)$` (§4.4:408): the non-capturing group
 * is what makes `a|b` mean "the whole value is `a` or `b`" rather than
 * "starts with `a`, or ends with `b`".
 *
 * ## The cache is per App spec hash (`plan.md:408`)
 *
 * "compiled once per App spec hash and cached" — so the key is
 * `(specHash, pattern)`, and a new App spec version gets its own entries rather
 * than inheriting a pattern compiled from the previous one. {@link
 * clearAppEnvPatternCache} takes an optional hash so the caller that replaces a
 * spec can drop exactly its entries. The cache holds compiled engines only: no
 * value ever enters it, and nothing is written back to disk.
 *
 * ## A refusal never contains the value (FR-19)
 *
 * Every message below interpolates the **name** and, where FR-19 requires it,
 * one or two **numbers**. Nothing interpolates `value`, and the refusal object
 * carries no copy of it — the spec asserts that for all eight codes.
 */

/** The rules `AppEnvEntryView.validation` exposes and `validateAppEnvValue` applies. */
export interface AppEnvValueRules {
    /** The exact length, in Unicode code points (FR-17). */
    readonly length?: number | null;
    readonly minLength?: number | null;
    readonly maxLength?: number | null;
    /** An RE2 pattern matched against the whole value (FR-17). */
    readonly pattern?: string | null;
}

/** What a caller may say about where the rules came from. */
export interface AppEnvValidationOptions {
    /** The App spec hash the pattern belongs to — the cache key of §4.4:408. */
    readonly specHash?: string | null;
}

/**
 * A refusal of FR-19 / plan §4.4:409-410.
 *
 * `details` is `{ expected, actual }` for the three length codes — the shape
 * S15's `lengthMismatch { expected: 32, actual: 44 }` fixes (`plan.md:409`) —
 * where `expected` is the exact, minimum or maximum the rule asked for. Numbers
 * and the name only: there is no field a value could travel in.
 */
export interface AppEnvValidationRefusal {
    readonly ok: false;
    readonly code: AppEnvValidationRefusalCode;
    readonly message: string;
    readonly details?: { readonly expected: number; readonly actual: number };
}

/** The answer: accepted, or the one refusal that stopped it. */
export type AppEnvValidationResult = { readonly ok: true } | AppEnvValidationRefusal;

/**
 * A `validate.pattern` this installation will not run.
 *
 * Neither code is a member-facing refusal: a pattern is App spec content, so
 * both are defects of the repository file that APW-03's editor reports first
 * (`pattern_unsupported`, `pattern`). They throw rather than returning a
 * refusal because a partially-applied rule would be worse than a loud failure —
 * a value that skips its pattern check is a value that reaches an app in a shape
 * it will reject at run time, somewhere far from here.
 */
export class AppEnvPatternError extends Error {
    readonly code: 'patternUnsupported' | 'patternInvalid';

    constructor(code: 'patternUnsupported' | 'patternInvalid', message: string) {
        super(message);
        this.name = 'AppEnvPatternError';
        this.code = code;
    }
}

/** Whether a caught value is {@link AppEnvPatternError}, across bundles. */
export function isAppEnvPatternError(value: unknown): value is AppEnvPatternError {
    if (value instanceof AppEnvPatternError) {
        return true;
    }
    return (
        typeof value === 'object' &&
        value !== null &&
        (value as { name?: unknown }).name === 'AppEnvPatternError' &&
        typeof (value as { code?: unknown }).code === 'string'
    );
}

/**
 * The part of an RE2 engine this module uses.
 *
 * Declared structurally rather than imported from `re2js`: the package ships its
 * types beside an ESM bundle and its `exports` map has no `types` condition, so a
 * type import would depend on the consumer's `moduleResolution`. This is the
 * whole surface used here, and `RE2JS` satisfies it.
 */
export interface AppEnvPatternEngine {
    matches(input: string): boolean;
}

/** One compiled pattern, cached per App spec hash (§4.4:408). */
export interface AppEnvCompiledPattern {
    /** The pattern as the App spec wrote it — without the `^(?:…)$` wrapper. */
    readonly pattern: string;
    /** The App spec hash this compilation belongs to, or `null` for an unscoped one. */
    readonly specHash: string | null;
    /** The RE2 engine. The same object is returned while the entry is cached. */
    readonly engine: AppEnvPatternEngine;
    /** True when the WHOLE value matches — what FR-17 requires. */
    matches(value: string): boolean;
}

/** The name grammar of FR-18, compiled once from the contract's own string. */
const NAME_PATTERN = new RegExp(APP_ENV_NAME_PATTERN);

/**
 * Syntax RE2 has and `RegExp` does not — the two the App spec's
 * `pattern_unsupported` issue names. Detected from the pattern TEXT rather than
 * from a parse error message, so the classification does not depend on the
 * engine's wording: look-around (`(?=` `(?!` `(?<=` `(?<!`), and
 * back-references (`\1`…`\9`). Named groups (`(?<name>…)`, `(?P<name>…)`) are
 * deliberately NOT in this list — RE2JS supports them.
 */
const UNSUPPORTED_PATTERN_SYNTAX = /\(\?(?:[=!]|<[=!])|\\[1-9]/;

/** `(specHash, pattern)` → the compiled pattern. Engines only; no value ever enters. */
const PATTERN_CACHE = new Map<string, AppEnvCompiledPattern>();

/**
 * Compile one App spec pattern, or return the cached compilation
 * (plan §4.4:408).
 *
 * `specHash` is optional so a caller that has no spec (a test, the editor's
 * preview) can still compile; entries compiled without one share a single
 * `null` scope.
 */
export function compileAppEnvPattern(
    pattern: string,
    specHash?: string | null,
): AppEnvCompiledPattern {
    if (typeof pattern !== 'string') {
        throw new AppEnvPatternError('patternInvalid', '`validate.pattern` must be a string.');
    }

    const scope = specHash ?? null;
    const key = `${scope ?? ''}\u0000${pattern}`;
    const cached = PATTERN_CACHE.get(key);
    if (cached) {
        return cached;
    }

    let engine: AppEnvPatternEngine;
    try {
        engine = RE2JS.compile(`^(?:${pattern})$`) as unknown as AppEnvPatternEngine;
    } catch (error) {
        if (UNSUPPORTED_PATTERN_SYNTAX.test(pattern)) {
            throw new AppEnvPatternError(
                'patternUnsupported',
                `${patternSubject(null)} uses a \`validate.pattern\` the resolver cannot run.`,
            );
        }
        throw new AppEnvPatternError(
            'patternInvalid',
            '`validate.pattern` is not a pattern this installation can compile.',
        );
    }

    const compiled: AppEnvCompiledPattern = {
        pattern,
        specHash: scope,
        engine,
        matches: (value: string): boolean => engine.matches(value),
    };
    PATTERN_CACHE.set(key, compiled);
    return compiled;
}

/** How many compiled patterns are cached — one per `(specHash, pattern)`. */
export function appEnvPatternCacheSize(): number {
    return PATTERN_CACHE.size;
}

/**
 * Drop cached compilations: all of them, or only one App spec hash's
 * (`plan.md:408`). Called when a spec is replaced, so a superseded pattern's
 * engine cannot be reused by a later value.
 */
export function clearAppEnvPatternCache(specHash?: string | null): void {
    if (specHash === undefined || specHash === null) {
        PATTERN_CACHE.clear();
        return;
    }
    for (const [key, compiled] of PATTERN_CACHE) {
        if (compiled.specHash === specHash) {
            PATTERN_CACHE.delete(key);
        }
    }
}

/**
 * Validate one value against one entry's rules (§4.4:406-411). The order of the
 * steps below **is** the plan's order — see the module docstring.
 *
 * Answers a refusal rather than throwing for anything a member can cause; only a
 * pattern this installation cannot run leaves by exception
 * ({@link AppEnvPatternError}), because that is a defect of the App spec rather
 * than of the member's input.
 */
export function validateAppEnvValue(
    name: string,
    value: string,
    rules?: AppEnvValueRules | null,
    options?: AppEnvValidationOptions | null,
): AppEnvValidationResult {
    // 1 — the name grammar (FR-18).
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
        return refusal(
            'invalidName',
            `\`${String(name)}\` isn't a valid environment variable name (names match ${APP_ENV_NAME_PATTERN}).`,
        );
    }

    // 2 — the platform's reserved prefix (FR-18).
    if (name.startsWith(APP_ENV_RESERVED_PREFIX)) {
        return refusal('reservedName', `\`${name}\` is reserved for Ever Works.`);
    }

    // 3 — the byte ceiling and the NUL ban (FR-18), in the plan's order.
    if (Buffer.byteLength(value, 'utf8') > APP_ENV_VALUE_MAX_BYTES) {
        return refusal(
            'valueTooLarge',
            `The value for \`${name}\` is larger than ${APP_ENV_VALUE_MAX_BYTES} bytes.`,
        );
    }
    if (value.includes('\u0000')) {
        return refusal('controlCharacter', `The value for \`${name}\` contains a NUL character.`);
    }

    // 4 — the three length rules, counted in Unicode code points so a multibyte
    // or astral-plane character counts once (matching APW-03's "generated
    // length", `works-config/schema/app-spec.rules.ts:405-419`). The count is
    // taken only when a rule needs it.
    const exact = rules?.length;
    const minimum = rules?.minLength;
    const maximum = rules?.maxLength;
    if (isSet(exact) || isSet(minimum) || isSet(maximum)) {
        const actual = countCodePoints(value);
        if (isSet(exact) && actual !== exact) {
            // S15's sentence, verbatim (`spec.md:155`).
            return refusal(
                'lengthMismatch',
                `\`${name}\` must be exactly ${exact} characters (this one has ${actual}).`,
                { expected: exact, actual },
            );
        }
        if (isSet(minimum) && actual < minimum) {
            return refusal(
                'tooShort',
                `\`${name}\` must be at least ${minimum} characters (this one has ${actual}).`,
                { expected: minimum, actual },
            );
        }
        if (isSet(maximum) && actual > maximum) {
            return refusal(
                'tooLong',
                `\`${name}\` must be at most ${maximum} characters (this one has ${actual}).`,
                { expected: maximum, actual },
            );
        }
    }

    // 5 — the pattern, matched against the whole value (FR-17). An EMPTY pattern
    // is a pattern that matches only the empty value (`^(?:)$`), not an omitted
    // one; only `undefined`/`null` mean "no pattern".
    if (typeof rules?.pattern === 'string') {
        const compiled = compileNamedPattern(rules.pattern, name, options?.specHash);
        if (!compiled.matches(value)) {
            // S16's sentence, verbatim (`spec.md:157`).
            return refusal(
                'patternMismatch',
                `\`${name}\` doesn't match the format the app expects.`,
            );
        }
    }

    return { ok: true };
}

/** Build one refusal — the only way this module answers "no". */
function refusal(
    code: AppEnvValidationRefusalCode,
    message: string,
    details?: { expected: number; actual: number },
): AppEnvValidationRefusal {
    return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

/** True for a rule a caller actually set (`0` is a value; `null`/`undefined` are not). */
function isSet(bound: number | null | undefined): bound is number {
    return typeof bound === 'number' && Number.isFinite(bound);
}

/**
 * Compile a pattern for one entry, naming that entry when RE2 refuses it — so
 * the sentence APW-03's editor prints and the one this resolver throws are the
 * same sentence about the same entry.
 */
function compileNamedPattern(
    pattern: string,
    name: string,
    specHash?: string | null,
): AppEnvCompiledPattern {
    try {
        return compileAppEnvPattern(pattern, specHash);
    } catch (error) {
        if (isAppEnvPatternError(error) && error.code === 'patternUnsupported') {
            throw new AppEnvPatternError(
                'patternUnsupported',
                `${patternSubject(name)} uses a \`validate.pattern\` the resolver cannot run.`,
            );
        }
        throw error;
    }
}

/** The subject of the `patternUnsupported` sentence — APW-03's wording, with the entry's name when there is one. */
function patternSubject(name: string | null): string {
    return name === null || name === undefined ? 'This entry' : `\`${name}\``;
}

/**
 * The number of Unicode code points in `value` — NOT `value.length`, which
 * counts UTF-16 units and would make an astral-plane character count twice
 * (`plan.md:406-407`, "counted in Unicode code points").
 *
 * Written as a loop rather than `Array.from(value).length` because this runs on
 * values up to 65,536 characters inside the 50 ms budget of FR-17.
 */
function countCodePoints(value: string): number {
    let count = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                index += 1;
            }
        }
        count += 1;
    }
    return count;
}
