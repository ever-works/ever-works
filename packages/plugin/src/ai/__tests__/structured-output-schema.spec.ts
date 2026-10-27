import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiOperations } from '../ai-operations';
import {
	findOptionalWithoutNullable,
	toStructuredOutputJsonSchema,
	usesJsonSchemaResponseFormat
} from '../structured-output-schema';

/**
 * zod 4 migration guard for `askJson` structured output.
 *
 * Under zod 3 the zod schema went to LangChain, and OpenAI's zod-3 helper both
 * converted it and refused `.optional()`-without-`.nullable()` properties before
 * any request. On zod 4 our pinned LangChain loses every `.describe()` and strips
 * `.transform()`s from the caller's schema in place, so `askJson` converts the
 * schema itself. These tests pin the zod-3 behaviour that conversion must keep.
 */

describe('findOptionalWithoutNullable — same verdicts as the zod-3 helper', () => {
	// Each row was measured against zod 3.25.76 + @langchain/openai 0.6.17:
	// `true` = refused client-side, `false` = request sent.
	const cases: Array<[string, z.ZodType, boolean]> = [
		['all required', z.object({ a: z.string() }), false],
		['optional', z.object({ a: z.string().optional() }), true],
		['nullable().optional()', z.object({ a: z.string().nullable().optional() }), false],
		['optional().nullable()', z.object({ a: z.string().optional().nullable() }), false],
		['nullish', z.object({ a: z.string().nullish() }), false],
		['default', z.object({ a: z.string().default('x') }), false],
		[
			'optional nested in an array of objects',
			z.object({ a: z.array(z.object({ b: z.string().optional() })) }),
			true
		],
		['optional array element', z.object({ a: z.array(z.string().optional()) }), false],
		['record', z.object({ a: z.record(z.string(), z.string()) }), false],
		['optional root', z.object({ a: z.string() }).optional(), false],
		['passthrough', z.object({ a: z.string() }).passthrough(), false],
		['optional union', z.object({ a: z.union([z.string(), z.number()]).optional() }), true],
		['catch', z.object({ a: z.string().catch('d') }), false],
		['transform', z.object({ a: z.string().transform((s) => s.length) }), false],
		[
			'optional under a transform',
			z.object({
				a: z
					.string()
					.optional()
					.transform((s) => s)
			}),
			true
		]
	];

	it.each(cases)('%s', (_label, schema, refused) => {
		expect(findOptionalWithoutNullable(schema) !== undefined).toBe(refused);
	});

	it('reports the JSON pointer the zod-3 helper reported', () => {
		expect(findOptionalWithoutNullable(z.object({ a: z.array(z.object({ b: z.string().optional() })) }))).toBe(
			'#/definitions/extract/properties/a/items/properties/b'
		);
	});

	it('terminates on a recursive schema', () => {
		type Node = { name: string; children: Node[] };
		const node: z.ZodType<Node> = z.lazy(() => z.object({ name: z.string(), children: z.array(node) }));
		expect(findOptionalWithoutNullable(z.object({ root: node }))).toBeUndefined();
	});
});

describe('usesJsonSchemaResponseFormat — mirrors @langchain/openai 0.6 method selection', () => {
	it.each([
		['gpt-4o-mini', true],
		['claude-sonnet-4', true],
		['gpt-4-turbo', false],
		['gpt-4', false],
		['gpt-3.5-turbo', false]
	])('%s → %s', (model, expected) => {
		expect(usesJsonSchemaResponseFormat(model)).toBe(expected);
	});
});

describe('toStructuredOutputJsonSchema', () => {
	const schema = z
		.object({
			name: z.string().describe('The canonical name'),
			tags: z.array(z.string()).nullable().optional(),
			count: z.number().default(3),
			nested: z.object({ url: z.string().describe('Source URL') })
		})
		.describe('An extracted item');

	it('keeps every .describe() — they are the extraction instructions', () => {
		const json = toStructuredOutputJsonSchema(schema, true) as {
			description?: string;
			properties: Record<string, { description?: string; properties?: Record<string, { description?: string }> }>;
		};
		expect(json.description).toBe('An extracted item');
		expect(json.properties.name.description).toBe('The canonical name');
		expect(json.properties.nested.properties?.url.description).toBe('Source URL');
	});

	it('strict mode lists every property as required and closes every object', () => {
		const json = toStructuredOutputJsonSchema(schema, true) as Record<string, unknown> & {
			properties: Record<string, Record<string, unknown>>;
		};
		expect(json.required).toEqual(['name', 'tags', 'count', 'nested']);
		expect(json.additionalProperties).toBe(false);
		expect(json.properties.nested.required).toEqual(['url']);
		expect(json.properties.nested.additionalProperties).toBe(false);
		expect(json.$schema).toBeUndefined();
	});

	it('non-strict mode leaves optional properties optional', () => {
		const json = toStructuredOutputJsonSchema(schema, false) as { required?: string[] };
		expect(json.required).toEqual(['name', 'nested']);
	});

	it('does not touch the caller schema', () => {
		const withTransform = z.object({ a: z.string().transform((s) => s.length) });
		toStructuredOutputJsonSchema(withTransform, true);
		expect(withTransform.parse({ a: 'xyz' })).toEqual({ a: 3 });
	});
});

describe('AiOperations.askJson structured output (zod 4)', () => {
	type SentBody = {
		response_format?: { type: string; json_schema?: { name: string; strict?: boolean; schema: any } };
		tools?: Array<{ function: { name: string; parameters: any } }>;
	};

	function stubOpenAi(answer: unknown): SentBody[] {
		const bodies: SentBody[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_url: unknown, init: { body: string }) => {
				const body = JSON.parse(init.body) as SentBody;
				bodies.push(body);
				const args = JSON.stringify(answer);
				const message = body.tools
					? {
							role: 'assistant',
							content: null,
							tool_calls: [
								{
									id: 'c1',
									type: 'function',
									function: { name: body.tools[0].function.name, arguments: args }
								}
							]
						}
					: { role: 'assistant', content: args };
				return new Response(
					JSON.stringify({
						id: 'r1',
						object: 'chat.completion',
						created: 1,
						model: 'm',
						choices: [{ index: 0, message, finish_reason: body.tools ? 'tool_calls' : 'stop' }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			})
		);
		return bodies;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	const ops = (model: string) => new AiOperations({ apiKey: 'sk-test', model, providerType: 'openai' });

	it('sends the descriptions in a strict json_schema and parses with the caller schema', async () => {
		const bodies = stubOpenAi({ name: 'Acme', size: 'abcd' });
		const schema = z.object({
			name: z.string().describe('The canonical name'),
			size: z.string().transform((s) => s.length),
			kind: z.string().default('tool')
		});

		const { result } = await ops('gpt-4o-mini').askJson('extract', schema);

		expect(result).toEqual({ name: 'Acme', size: 4, kind: 'tool' });
		expect(bodies).toHaveLength(1);
		const format = bodies[0].response_format;
		expect(format?.type).toBe('json_schema');
		expect(format?.json_schema?.strict).toBe(true);
		expect(format?.json_schema?.name).toBe('extract');
		expect(format?.json_schema?.schema.properties.name.description).toBe('The canonical name');
		// The caller's schema keeps its transform after the call.
		expect(schema.parse({ name: 'x', size: 'xy' })).toEqual({ name: 'x', size: 2, kind: 'tool' });
	});

	it('falls back to a plain completion without a request for an optional-without-nullable schema', async () => {
		const bodies = stubOpenAi({ name: 'Acme' });
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		const schema = z.object({ name: z.string(), note: z.string().optional() });

		const { result } = await ops('gpt-4o-mini').askJson('extract', schema);

		expect(result).toEqual({ name: 'Acme' });
		expect(bodies).toHaveLength(1);
		expect(bodies[0].response_format).toBeUndefined();
		expect(String(warn.mock.calls[0]?.[1])).toContain('uses `.optional()` without `.nullable()`');
		warn.mockRestore();
	});

	it('uses function calling (no strict flag) for the models LangChain routes there', async () => {
		const bodies = stubOpenAi({ name: 'Acme' });
		const schema = z.object({ name: z.string().describe('The canonical name'), note: z.string().optional() });

		const { result } = await ops('gpt-4-turbo').askJson('extract', schema);

		expect(result).toEqual({ name: 'Acme' });
		expect(bodies[0].response_format).toBeUndefined();
		const fn = bodies[0].tools?.[0].function as { name: string; parameters: any; strict?: boolean };
		expect(fn.name).toBe('extract');
		expect(fn.strict).toBeUndefined();
		expect(fn.parameters.properties.name.description).toBe('The canonical name');
		expect(fn.parameters.required).toEqual(['name']);
	});
});
