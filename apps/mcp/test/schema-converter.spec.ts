import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { SchemaConverterService, type JsonSchema } from '../src/openapi-tools/schema-converter.service.js';

describe('SchemaConverterService', () => {
	const converter = new SchemaConverterService();

	describe('convertToZod', () => {
		it('converts string type', () => {
			const schema: JsonSchema = { type: 'string', description: 'A name' };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse('hello').success).toBe(true);
			expect(zodType.safeParse(42).success).toBe(false);
		});

		it('converts string with uuid format', () => {
			const schema: JsonSchema = { type: 'string', format: 'uuid' };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(true);
			expect(zodType.safeParse('not-a-uuid').success).toBe(false);
		});

		it('converts string with url format', () => {
			const schema: JsonSchema = { type: 'string', format: 'url' };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse('https://example.com').success).toBe(true);
			expect(zodType.safeParse('not-a-url').success).toBe(false);
		});

		it('accepts offset and naive ISO timestamps for date-time, like the API IsDateString does', () => {
			const schema: JsonSchema = { type: 'string', format: 'date-time' };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse('2026-09-04T09:00:00Z').success).toBe(true);
			expect(zodType.safeParse('2026-09-04T09:00:00+02:00').success).toBe(true);
			expect(zodType.safeParse('2026-09-04T09:00:00').success).toBe(true);
			// A bare date is not a date-time for either side.
			expect(zodType.safeParse('2026-09-04').success).toBe(false);
			expect(zodType.safeParse('tomorrow').success).toBe(false);
		});

		describe('nullable (OpenAPI 3.0 spelling of "may be null")', () => {
			it('accepts null for a required nullable string (workId: null detaches a Task from its Work)', () => {
				const schema: JsonSchema = { type: 'string', nullable: true };
				const zodType = converter.convertToZod(schema, true);
				expect(zodType.safeParse(null).success).toBe(true);
				expect(zodType.safeParse('abc').success).toBe(true);
				expect(zodType.safeParse(undefined).success).toBe(false);
			});

			it('accepts null and undefined for an optional nullable string', () => {
				const schema: JsonSchema = { type: 'string', nullable: true };
				const zodType = converter.convertToZod(schema, false);
				expect(zodType.safeParse(null).success).toBe(true);
				expect(zodType.safeParse(undefined).success).toBe(true);
				expect(zodType.safeParse(42).success).toBe(false);
			});

			it('still rejects null when the schema is not nullable', () => {
				expect(converter.convertToZod({ type: 'string' }, true).safeParse(null).success).toBe(false);
				expect(converter.convertToZod({ type: 'string' }, false).safeParse(null).success).toBe(false);
			});

			it('accepts an enum member or null for a nullable enum (isolationMode)', () => {
				const schema: JsonSchema = { enum: ['worktree', 'container'], nullable: true };
				const zodType = converter.convertToZod(schema, true);
				expect(zodType.safeParse('worktree').success).toBe(true);
				expect(zodType.safeParse(null).success).toBe(true);
				expect(zodType.safeParse('vm').success).toBe(false);
			});

			it('carries nullable through a request body property', () => {
				const body: JsonSchema = {
					type: 'object',
					properties: { workId: { type: 'string', format: 'uuid', nullable: true } },
					required: ['workId']
				};
				const result = converter.buildToolParameters([], [], body);
				expect(result.safeParse({ workId: null }).success).toBe(true);
				expect(result.safeParse({ workId: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true);
				expect(result.safeParse({ workId: 'not-a-uuid' }).success).toBe(false);
			});
		});

		it('converts integer type', () => {
			const schema: JsonSchema = { type: 'integer' };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse(42).success).toBe(true);
			expect(zodType.safeParse(3.14).success).toBe(false);
		});

		it('converts number type with min/max', () => {
			const schema: JsonSchema = { type: 'number', minimum: 1, maximum: 10 };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse(5).success).toBe(true);
			expect(zodType.safeParse(0).success).toBe(false);
			expect(zodType.safeParse(11).success).toBe(false);
		});

		it('converts boolean type', () => {
			const schema: JsonSchema = { type: 'boolean' };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse(true).success).toBe(true);
			expect(zodType.safeParse('yes').success).toBe(false);
		});

		it('converts enum', () => {
			const schema: JsonSchema = { enum: ['create-update', 'create-only', 'update-only'] };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse('create-update').success).toBe(true);
			expect(zodType.safeParse('invalid').success).toBe(false);
		});

		it('converts array type', () => {
			const schema: JsonSchema = { type: 'array', items: { type: 'string' } };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse(['a', 'b']).success).toBe(true);
			expect(zodType.safeParse([1, 2]).success).toBe(false);
		});

		it('carries minItems / maxItems into the array schema (run-batch and extraRepos limits)', () => {
			const schema: JsonSchema = { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse([]).success).toBe(false);
			expect(zodType.safeParse(['a']).success).toBe(true);
			expect(zodType.safeParse(['a', 'b']).success).toBe(true);
			expect(zodType.safeParse(['a', 'b', 'c']).success).toBe(false);
		});

		it('ignores malformed array bounds instead of throwing', () => {
			const schema = { type: 'array', items: { type: 'string' }, minItems: -1, maxItems: 1.5 } as JsonSchema;
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse([]).success).toBe(true);
			expect(zodType.safeParse(['a', 'b', 'c']).success).toBe(true);
		});

		it('converts object type with required/optional props', () => {
			const schema: JsonSchema = {
				type: 'object',
				properties: {
					name: { type: 'string' },
					age: { type: 'integer' }
				},
				required: ['name']
			};
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse({ name: 'Test' }).success).toBe(true);
			expect(zodType.safeParse({ age: 25 }).success).toBe(false);
		});

		it('makes field optional when required=false', () => {
			const schema: JsonSchema = { type: 'string' };
			const zodType = converter.convertToZod(schema, false);
			expect(zodType.safeParse(undefined).success).toBe(true);
			expect(zodType.safeParse('hello').success).toBe(true);
		});

		it('handles allOf by merging properties', () => {
			const schema: JsonSchema = {
				allOf: [
					{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
					{ type: 'object', properties: { b: { type: 'number' } } }
				]
			};
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse({ a: 'hello', b: 42 }).success).toBe(true);
			expect(zodType.safeParse({ b: 42 }).success).toBe(false);
		});

		it('falls back to z.any() for oneOf/anyOf', () => {
			const schema: JsonSchema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse('hello').success).toBe(true);
			expect(zodType.safeParse(42).success).toBe(true);
		});

		it('falls back to z.any() for unknown types', () => {
			const schema: JsonSchema = {};
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse('anything').success).toBe(true);
		});

		it('converts object without properties to record', () => {
			const schema: JsonSchema = { type: 'object' };
			const zodType = converter.convertToZod(schema, true);
			expect(zodType.safeParse({ key: 'value' }).success).toBe(true);
		});
	});

	describe('buildToolParameters', () => {
		it('merges path, query, and body params into a single schema', () => {
			const pathParams = [{ name: 'id', required: true, schema: { type: 'string' } as JsonSchema }];
			const queryParams = [{ name: 'limit', required: false, schema: { type: 'integer' } as JsonSchema }];
			const body: JsonSchema = {
				type: 'object',
				properties: { name: { type: 'string' } },
				required: ['name']
			};

			const result = converter.buildToolParameters(pathParams, queryParams, body);
			expect(result.safeParse({ id: '123', name: 'Test' }).success).toBe(true);
			expect(result.safeParse({ id: '123', name: 'Test', limit: 10 }).success).toBe(true);
			expect(result.safeParse({ name: 'Test' }).success).toBe(false); // missing required id
		});

		it('path params are always required', () => {
			const pathParams = [{ name: 'id', required: true, schema: { type: 'string' } as JsonSchema }];
			const result = converter.buildToolParameters(pathParams, [], undefined);
			expect(result.safeParse({}).success).toBe(false);
			expect(result.safeParse({ id: '123' }).success).toBe(true);
		});

		it('does not override path/query params with body params of same name', () => {
			const pathParams = [
				{ name: 'id', required: true, schema: { type: 'string', format: 'uuid' } as JsonSchema }
			];
			const body: JsonSchema = {
				type: 'object',
				properties: { id: { type: 'integer' } }
			};
			const result = converter.buildToolParameters(pathParams, [], body);
			// Should use the path param definition (string/uuid), not the body one (integer)
			expect(result.safeParse({ id: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true);
		});

		it('returns empty object schema when no params', () => {
			const result = converter.buildToolParameters([], [], undefined);
			expect(result.safeParse({}).success).toBe(true);
		});

		it('uses param description as field description', () => {
			const params = [
				{
					name: 'id',
					required: true,
					schema: { type: 'string' } as JsonSchema,
					description: 'Work ID (UUID)'
				}
			];
			const result = converter.buildToolParameters(params, [], undefined);
			const shape = result.shape;
			expect(shape.id.description).toBe('Work ID (UUID)');
		});
	});
});
