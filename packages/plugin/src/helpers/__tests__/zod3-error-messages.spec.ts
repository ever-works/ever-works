import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZOD3_ERROR_MESSAGES, zod3ErrorMessage } from '../zod3-error-messages';

/**
 * Every expected string below is what zod 3.25.76 produced for the same schema
 * and input (measured side by side during the zod 4 migration). They are the
 * messages people and API clients saw before the upgrade; the map exists so
 * they keep seeing them.
 */
const firstMessage = (schema: z.ZodType, input: unknown): string => {
	const result = schema.safeParse(input, ZOD3_ERROR_MESSAGES);
	if (result.success) throw new Error('expected a validation failure');
	const issue = result.error.issues[0];
	return `${issue.path.join('.')}:${issue.message}`;
};

describe('zod3ErrorMessage — zod 3 default messages under zod 4', () => {
	const cases: Array<[string, z.ZodType, unknown, string]> = [
		['missing key', z.object({ a: z.string() }), {}, 'a:Required'],
		['wrong type', z.object({ a: z.string() }), { a: 1 }, 'a:Expected string, received number'],
		['null', z.string(), null, ':Expected string, received null'],
		['NaN', z.number(), Number.NaN, ':Expected number, received nan'],
		['int', z.number().int(), 1.5, ':Expected integer, received float'],
		['number min', z.number().int().min(1), 0, ':Number must be greater than or equal to 1'],
		['number max', z.number().max(10), 11, ':Number must be less than or equal to 10'],
		['positive', z.number().positive(), 0, ':Number must be greater than 0'],
		['lt', z.number().lt(5), 5, ':Number must be less than 5'],
		['multipleOf', z.number().multipleOf(3), 4, ':Number must be a multiple of 3'],
		['string min', z.string().min(3), 'ab', ':String must contain at least 3 character(s)'],
		['string max', z.string().max(3), 'abcd', ':String must contain at most 3 character(s)'],
		['string length', z.string().length(3), 'ab', ':String must contain exactly 3 character(s)'],
		['array min', z.array(z.string()).min(1), [], ':Array must contain at least 1 element(s)'],
		['array max', z.array(z.string()).max(1), ['a', 'b'], ':Array must contain at most 1 element(s)'],
		['email', z.string().email(), 'nope', ':Invalid email'],
		['url', z.string().url(), 'nope', ':Invalid url'],
		['guid (zod 3 uuid)', z.guid(), 'nope', ':Invalid uuid'],
		['regex', z.string().regex(/^a$/), 'b', ':Invalid'],
		['startsWith', z.string().startsWith('x'), 'b', ':Invalid input: must start with "x"'],
		['datetime', z.string().datetime(), 'b', ':Invalid datetime'],
		['enum value', z.enum(['a', 'b']), 'c', ":Invalid enum value. Expected 'a' | 'b', received 'c'"],
		['enum type', z.enum(['a', 'b']), 5, ":Expected 'a' | 'b', received number"],
		['enum missing', z.object({ e: z.enum(['a', 'b']) }), {}, 'e:Required'],
		['literal', z.literal('works.ever.works/v1'), 'v2', ':Invalid literal value, expected "works.ever.works/v1"'],
		[
			'strict',
			z.object({ a: z.string() }).strict(),
			{ a: 'x', b: 1, c: 2 },
			":Unrecognized key(s) in object: 'b', 'c'"
		],
		['union', z.union([z.string(), z.number()]), true, ':Invalid input'],
		[
			'discriminator',
			z.discriminatedUnion('type', [z.object({ type: z.literal('a') }), z.object({ type: z.literal('b') })]),
			{ type: 'c' },
			"type:Invalid discriminator value. Expected 'a' | 'b'"
		],
		['refine', z.string().refine(() => false), 'x', ':Invalid input'],
		['record value', z.record(z.string(), z.number()), { a: 'x' }, 'a:Expected number, received string'],
		['email or empty', z.string().email().nullable().optional().or(z.literal('')), 'bad', ':Invalid email'],
		[
			'record key',
			z.record(z.string().max(3), z.string()),
			{ toolong: 'x' },
			'toolong:String must contain at most 3 character(s)'
		],
		['invalid date', z.date(), new Date('not a date'), ':Invalid date'],
		['guid check keeps Required', z.object({ id: z.string().guid('Bad id') }), {}, 'id:Required'],
		['guid check message', z.object({ id: z.string().guid('Bad id') }), { id: 'x' }, 'id:Bad id']
	];

	it.each(cases)('%s', (_label, schema, input, expected) => {
		expect(firstMessage(schema, input)).toBe(expected);
	});

	it('leaves a message set on the schema alone', () => {
		expect(firstMessage(z.string().min(3, 'too short!'), 'a')).toBe(':too short!');
		expect(
			firstMessage(
				z.string().refine(() => false, { message: 'custom!' }),
				'x'
			)
		).toBe(':custom!');
		expect(firstMessage(z.string().email('Enter a valid email'), 'x')).toBe(':Enter a valid email');
	});

	it('falls through to zod 4 for checks zod 3 never had', () => {
		expect(zod3ErrorMessage({ code: 'invalid_format', format: 'lowercase' })).toBeUndefined();
	});
});
