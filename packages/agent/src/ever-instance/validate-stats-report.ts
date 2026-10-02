import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import { EVER_STATS_MAX_BODY_BYTES } from '@ever-works/contracts';
// `import * as` + a `.default` fallback resolves the JSON the same way under the
// agent's SWC build, apps/api's ts-jest harness and the tasks bundle (the same
// rule as `subscriptions/billing/stripe-catalog.ts`).
import * as schemaModule from './contract/ever.stats.v1.schema.data.json';

/**
 * The vendored `ever.stats.v1` schema (byte-exact copy of the published file;
 * `contract/VENDOR.json` records where it came from and its SHA-256).
 */
export const EVER_STATS_V1_SCHEMA: Record<string, unknown> =
    (schemaModule as unknown as { default?: Record<string, unknown> }).default ??
    (schemaModule as unknown as Record<string, unknown>);

/** One refusal: a JSON pointer, a closed code and a message that never repeats the value. */
export interface StatsReportValidationError {
    path: string;
    code:
        | 'too_large'
        | 'invalid_json'
        | 'duplicate_key'
        | 'not_an_integer'
        | 'unknown_field'
        | 'type'
        | 'pattern'
        | 'range'
        | 'required'
        | 'schema';
    message: string;
}

export type StatsReportValidation =
    | { ok: true }
    | { ok: false; errors: StatsReportValidationError[] };

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
    if (!compiled) {
        // Strict mode: an unknown keyword or an ambiguous schema is a compile
        // error, not a silently ignored rule.
        const ajv = new Ajv2020({ strict: true, allErrors: true });
        compiled = ajv.compile(EVER_STATS_V1_SCHEMA);
    }
    return compiled;
}

/**
 * Validate a report OBJECT against the vendored schema (strict, all errors).
 * The builder calls this before anything is signed; a failure never sends.
 */
export function validateStatsReport(report: unknown): StatsReportValidation {
    const validate = validator();
    if (validate(report)) return { ok: true };
    return { ok: false, errors: toErrors(validate.errors ?? [], report) };
}

/**
 * Validate the exact BODY that would be sent, the way the receiver does: at
 * most 16 KiB, well-formed JSON, every key at most once per object, every
 * number written as an integer (no fraction, no exponent), then the schema.
 */
export function validateStatsReportBody(body: Uint8Array | string): StatsReportValidation {
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    if (bytes.length > EVER_STATS_MAX_BODY_BYTES) {
        return {
            ok: false,
            errors: [{ path: '', code: 'too_large', message: 'body exceeds 16384 bytes' }],
        };
    }
    const text = bytes.toString('utf8');
    const lexical = scanJson(text);
    if (lexical) return { ok: false, errors: [lexical] };
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, errors: [{ path: '', code: 'invalid_json', message: 'not JSON' }] };
    }
    return validateStatsReport(parsed);
}

/**
 * Turn ajv's errors into the receiver's shape, most relevant first.
 *
 * The schema's per-product `oneOf` makes ajv report every branch; the branches
 * whose `product` constant did not match are noise, so their errors (the ones
 * raised inside another product's `$defs`), the `product` constant mismatches
 * and the `oneOf` summary are dropped.
 * For an unknown key the path names the key itself (`/tenant_name`).
 */
function toErrors(raw: ErrorObject[], report: unknown): StatsReportValidationError[] {
    const product =
        report && typeof report === 'object'
            ? (report as { product?: unknown }).product
            : undefined;
    const otherBranch = (schemaPath: string) => {
        const match = schemaPath.match(/^#\/\$defs\/([a-z]+)\//);
        return match !== null && match[1] !== product;
    };
    const relevant = raw.filter(
        (error) =>
            !(error.keyword === 'const' && error.instancePath === '/product') &&
            error.keyword !== 'oneOf' &&
            error.keyword !== 'if' &&
            !otherBranch(error.schemaPath),
    );
    const pool = relevant.length > 0 ? relevant : raw;
    const seen = new Set<string>();
    const out: StatsReportValidationError[] = [];
    for (const error of pool) {
        const mapped = mapError(error);
        const key = `${mapped.path}|${mapped.code}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(mapped);
    }
    return out.slice(0, 20);
}

function mapError(error: ErrorObject): StatsReportValidationError {
    const path = error.instancePath;
    switch (error.keyword) {
        case 'additionalProperties': {
            const property = String(
                (error.params as { additionalProperty?: unknown }).additionalProperty ?? '',
            );
            return {
                path: `${path}/${escapePointer(property)}`,
                code: 'unknown_field',
                message: 'field not in the published schema',
            };
        }
        case 'propertyNames':
            return { path, code: 'unknown_field', message: 'map key not in the closed list' };
        case 'required': {
            const property = String(
                (error.params as { missingProperty?: unknown }).missingProperty ?? '',
            );
            return {
                path: `${path}/${escapePointer(property)}`,
                code: 'required',
                message: 'required field missing',
            };
        }
        case 'type':
            return { path, code: 'type', message: `must be ${String(error.params.type)}` };
        case 'pattern':
        case 'enum':
        case 'const':
        case 'maxLength':
        case 'minLength':
            return { path, code: 'pattern', message: 'value outside the allowed form' };
        case 'minimum':
        case 'maximum':
        case 'maxItems':
        case 'minItems':
        case 'uniqueItems':
        case 'maxProperties':
            return { path, code: 'range', message: 'value outside the allowed range' };
        default:
            return { path, code: 'schema', message: `violates ${error.keyword}` };
    }
}

function escapePointer(segment: string): string {
    return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * A small JSON scanner for the two rules `JSON.parse` cannot see: a key that
 * appears twice in one object, and a number written with a fraction or an
 * exponent (`214.0` is not an integer on the wire). Returns the first problem
 * with its JSON pointer, or `null`.
 */
function scanJson(text: string): StatsReportValidationError | null {
    let i = 0;
    const fail = (path: string, code: StatsReportValidationError['code'], message: string) => ({
        path,
        code,
        message,
    });

    const skipWs = () => {
        while (i < text.length && /\s/.test(text[i])) i += 1;
    };

    const readString = (): string | null => {
        if (text[i] !== '"') return null;
        let out = '';
        i += 1;
        while (i < text.length) {
            const ch = text[i];
            if (ch === '"') {
                i += 1;
                return out;
            }
            if (ch === '\\') {
                const next = text[i + 1];
                if (next === 'u') {
                    out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
                    i += 6;
                } else {
                    out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
                    i += 2;
                }
                continue;
            }
            out += ch;
            i += 1;
        }
        return null;
    };

    const readValue = (path: string): StatsReportValidationError | null | 'bad' => {
        skipWs();
        const ch = text[i];
        if (ch === '{') {
            i += 1;
            const keys = new Set<string>();
            skipWs();
            if (text[i] === '}') {
                i += 1;
                return null;
            }
            while (i < text.length) {
                skipWs();
                const key = readString();
                if (key === null) return 'bad';
                const childPath = `${path}/${escapePointer(key)}`;
                if (keys.has(key)) return fail(childPath, 'duplicate_key', 'key appears twice');
                keys.add(key);
                skipWs();
                if (text[i] !== ':') return 'bad';
                i += 1;
                const nested = readValue(childPath);
                if (nested) return nested;
                skipWs();
                if (text[i] === ',') {
                    i += 1;
                    continue;
                }
                if (text[i] === '}') {
                    i += 1;
                    return null;
                }
                return 'bad';
            }
            return 'bad';
        }
        if (ch === '[') {
            i += 1;
            let index = 0;
            skipWs();
            if (text[i] === ']') {
                i += 1;
                return null;
            }
            while (i < text.length) {
                const nested = readValue(`${path}/${index}`);
                if (nested) return nested;
                index += 1;
                skipWs();
                if (text[i] === ',') {
                    i += 1;
                    continue;
                }
                if (text[i] === ']') {
                    i += 1;
                    return null;
                }
                return 'bad';
            }
            return 'bad';
        }
        if (ch === '"') {
            return readString() === null ? 'bad' : null;
        }
        const literal = text.slice(i).match(/^(true|false|null)/);
        if (literal) {
            i += literal[0].length;
            return null;
        }
        const number = text.slice(i).match(/^-?\d+(\.\d+)?([eE][+-]?\d+)?/);
        if (number) {
            i += number[0].length;
            if (number[1] !== undefined || number[2] !== undefined) {
                return fail(path, 'not_an_integer', 'numbers are integers on the wire');
            }
            return null;
        }
        return 'bad';
    };

    const result = readValue('');
    if (result === 'bad') return fail('', 'invalid_json', 'not JSON');
    if (result) return result;
    skipWs();
    if (i !== text.length) return fail('', 'invalid_json', 'not JSON');
    return null;
}
