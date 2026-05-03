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
