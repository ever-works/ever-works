/**
 * zod 3's default English error messages, for zod 4.
 *
 * zod 4 rewrote every default message ("Required" became "Invalid input:
 * expected string, received undefined", "Invalid email" became "Invalid email
 * address", ...). Messages we hand to people or to API clients — server-action
 * toasts, manifest validation errors, the subcodes derived from them — must not
 * change with the library upgrade, so callers that surface default messages
 * pass this map:
 *
 *     schema.safeParse(input, { error: zod3ErrorMessage });
 *
 * or install it process-wide with `z.config({ customError: zod3ErrorMessage })`.
 * A message set on the schema itself (`.min(1, 'Name is required')`,
 * `.refine(fn, { message })`) still wins over this map, exactly as it won over
 * zod 3's default map. Issues zod 3 had no message for fall through to zod 4's
 * own default (the map returns `undefined`).
 */

/** The parts of a zod 4 raw issue this map reads. */
export interface Zod3MessageIssue {
	readonly code?: string;
	readonly input?: unknown;
	readonly expected?: string;
	readonly origin?: string;
	readonly minimum?: number | bigint;
	readonly maximum?: number | bigint;
	readonly inclusive?: boolean;
	readonly exact?: boolean;
	readonly format?: string;
	readonly prefix?: string;
	readonly suffix?: string;
	readonly includes?: string;
	readonly values?: readonly unknown[];
	readonly keys?: readonly string[];
	readonly discriminator?: string;
	readonly options?: readonly unknown[];
	readonly divisor?: number;
	readonly inst?: unknown;
}

/** zod 3's `getParsedType`, which named the `received` side of its messages. */
export function zod3ParsedType(data: unknown): string {
	switch (typeof data) {
		case 'undefined':
			return 'undefined';
		case 'string':
			return 'string';
		case 'number':
			return Number.isNaN(data) ? 'nan' : 'number';
		case 'boolean':
			return 'boolean';
		case 'function':
			return 'function';
		case 'bigint':
			return 'bigint';
		case 'symbol':
			return 'symbol';
		case 'object': {
			if (Array.isArray(data)) return 'array';
			if (data === null) return 'null';
			const thenable = data as { then?: unknown; catch?: unknown };
			if (typeof thenable.then === 'function' && typeof thenable.catch === 'function') return 'promise';
			if (data instanceof Map) return 'map';
			if (data instanceof Set) return 'set';
			if (data instanceof Date) return 'date';
			return 'object';
		}
		default:
			return 'unknown';
	}
}

function joinValues(values: readonly unknown[], separator = ' | '): string {
	return values.map((value) => (typeof value === 'string' ? `'${value}'` : value)).join(separator);
}

function bigIntSafe(_key: string, value: unknown): unknown {
	return typeof value === 'bigint' ? value.toString() : value;
}

function schemaType(issue: Zod3MessageIssue): string | undefined {
	return (issue.inst as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def?.type;
}

/** zod 4 `expected` names that zod 3 spelled differently. */
const ZOD3_EXPECTED: Readonly<Record<string, string>> = {
	record: 'object',
	tuple: 'array'
};

/** zod 4 string formats whose zod 3 `validation` name differs. */
const ZOD3_FORMAT: Readonly<Record<string, string>> = {
	guid: 'uuid',
	ipv4: 'ip',
	ipv6: 'ip',
	cidrv4: 'cidr',
	cidrv6: 'cidr'
};

/** Formats zod 3 had no check for — left to zod 4's default message. */
const ZOD4_ONLY_FORMATS = new Set(['lowercase', 'uppercase', 'e164', 'ksuid', 'xid', 'mac', 'hex', 'hash']);

function invalidType(issue: Zod3MessageIssue): string {
	if (issue.input === undefined) return 'Required';
	const received = zod3ParsedType(issue.input);
	if (issue.expected === 'int') {
		// zod 3's `.int()` reported a non-integer number as a float.
		return typeof issue.input === 'number' ? 'Expected integer, received float' : `Expected number, received ${received}`;
	}
	const expected = ZOD3_EXPECTED[issue.expected ?? ''] ?? issue.expected;
	return `Expected ${expected}, received ${received}`;
}

function invalidValue(issue: Zod3MessageIssue): string {
	const values = issue.values ?? [];
	if (schemaType(issue) === 'literal') {
		return `Invalid literal value, expected ${JSON.stringify(values.length === 1 ? values[0] : values, bigIntSafe)}`;
	}
	if (issue.input === undefined) return 'Required';
	const stringEnum = values.every((value) => typeof value === 'string');
	const input = issue.input;
	if ((stringEnum && typeof input !== 'string') || (typeof input !== 'string' && typeof input !== 'number')) {
		return `Expected ${joinValues(values)}, received ${zod3ParsedType(input)}`;
	}
	return `Invalid enum value. Expected ${joinValues(values)}, received '${String(input)}'`;
}

function invalidFormat(issue: Zod3MessageIssue): string | undefined {
	const format = issue.format ?? '';
	switch (format) {
		case 'regex':
			return 'Invalid';
		case 'starts_with':
			return `Invalid input: must start with "${issue.prefix}"`;
		case 'ends_with':
			return `Invalid input: must end with "${issue.suffix}"`;
		case 'includes':
			return `Invalid input: must include "${issue.includes}"`;
		default:
			if (!format || ZOD4_ONLY_FORMATS.has(format)) return undefined;
			return `Invalid ${ZOD3_FORMAT[format] ?? format}`;
	}
}

function tooSmall(issue: Zod3MessageIssue): string {
	const { exact, inclusive, minimum } = issue;
	switch (issue.origin) {
		case 'array':
			return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${minimum} element(s)`;
		case 'string':
			return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${minimum} character(s)`;
		case 'number':
		case 'int':
		case 'bigint':
			return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${minimum}`;
		case 'date':
			return `Date must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${new Date(Number(minimum))}`;
		default:
			return 'Invalid input';
	}
}

function tooBig(issue: Zod3MessageIssue): string {
	const { exact, inclusive, maximum } = issue;
	switch (issue.origin) {
		case 'array':
			return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${maximum} element(s)`;
		case 'string':
			return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${maximum} character(s)`;
		case 'number':
		case 'int':
			return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
		case 'bigint':
			return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
		case 'date':
			return `Date must be ${exact ? 'exactly' : inclusive ? 'smaller than or equal to' : 'smaller than'} ${new Date(Number(maximum))}`;
		default:
			return 'Invalid input';
	}
}

/**
 * The zod 3 default message for a zod 4 issue, or `undefined` to keep zod 4's
 * default. Usable as a per-parse `error` option or as `z.config({ customError })`.
 */
export function zod3ErrorMessage(issue: Zod3MessageIssue): string | undefined {
	switch (issue.code) {
		case 'invalid_type':
			return invalidType(issue);
		case 'invalid_value':
			return invalidValue(issue);
		case 'unrecognized_keys':
			return `Unrecognized key(s) in object: ${joinValues(issue.keys ?? [], ', ')}`;
		case 'invalid_union':
			if (issue.discriminator !== undefined && issue.options) {
				return `Invalid discriminator value. Expected ${joinValues(issue.options)}`;
			}
			return 'Invalid input';
		case 'invalid_format':
			return invalidFormat(issue);
		case 'too_small':
			return tooSmall(issue);
		case 'too_big':
			return tooBig(issue);
		case 'not_multiple_of':
			return `Number must be a multiple of ${issue.divisor}`;
		case 'custom':
			return 'Invalid input';
		default:
			return undefined;
	}
}

/** Parse options that give a parse zod 3's default messages: `schema.safeParse(input, ZOD3_ERROR_MESSAGES)`. */
export const ZOD3_ERROR_MESSAGES = Object.freeze({ error: zod3ErrorMessage });
