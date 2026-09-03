import { Injectable } from '@nestjs/common';
import { z } from 'zod';

export interface JsonSchema {
	type?: string;
	format?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	items?: JsonSchema;
	enum?: unknown[];
	description?: string;
	allOf?: JsonSchema[];
	oneOf?: JsonSchema[];
	anyOf?: JsonSchema[];
	default?: unknown;
	minimum?: number;
	maximum?: number;
	minLength?: number;
	maxLength?: number;
	/** OpenAPI 3.0 spelling of "may be null" (`@ApiProperty({ nullable: true })`). */
	nullable?: boolean;
	/** Array bounds (`@ArrayMinSize` / `@ArrayMaxSize`, `maxItems` on `@ApiProperty`). */
	minItems?: number;
	maxItems?: number;
	[key: string]: unknown;
}

export interface OpenApiParam {
	name: string;
	required: boolean;
	schema: JsonSchema;
	description?: string;
}

@Injectable()
export class SchemaConverterService {
	buildToolParameters(
		pathParams: OpenApiParam[],
		queryParams: OpenApiParam[],
		requestBody?: JsonSchema
	): z.ZodObject<Record<string, z.ZodTypeAny>> {
		const shape: Record<string, z.ZodTypeAny> = {};

		for (const param of pathParams) {
			shape[param.name] = this.convertParam(param, true);
		}

		for (const param of queryParams) {
			shape[param.name] = this.convertParam(param, param.required);
		}

		if (requestBody?.properties) {
			const requiredFields = new Set(requestBody.required || []);
			for (const [key, propSchema] of Object.entries(requestBody.properties)) {
				if (!(key in shape)) {
					shape[key] = this.convertToZod(propSchema, requiredFields.has(key));
				}
			}
		}

		return z.object(shape);
	}

	convertToZod(schema: JsonSchema, required: boolean): z.ZodTypeAny {
		let zodType = this.convertType(schema);

		// Why: the API uses `null` as a first-class value on many fields ("detach
		// this Task from its Work", "inherit the Work's gate budget"). Nest emits
		// that as OpenAPI 3.0 `nullable: true`; without this the Zod schema would
		// reject exactly the value the endpoint documents.
		if (schema.nullable === true) {
			zodType = zodType.nullable();
		}

		if (schema.description) {
			zodType = zodType.describe(schema.description);
		}

		if (!required) {
			zodType = zodType.optional();
		}

		return zodType;
	}

	private convertParam(param: OpenApiParam, required: boolean): z.ZodTypeAny {
		const schema: JsonSchema = { ...param.schema };
		if (param.description && !schema.description) {
			schema.description = param.description;
		}
		return this.convertToZod(schema, required);
	}

	private convertType(schema: JsonSchema): z.ZodTypeAny {
		if (schema.enum && schema.enum.length > 0) {
			const values = schema.enum.map(String);
			return z.enum(values as [string, ...string[]]);
		}

		if (schema.allOf && schema.allOf.length > 0) {
			return this.mergeAllOf(schema.allOf);
		}

		if (schema.oneOf || schema.anyOf) {
			return z.any();
		}

		switch (schema.type) {
			case 'string':
				return this.convertString(schema);
			case 'number':
			case 'integer':
				return this.convertNumber(schema);
			case 'boolean':
				return z.boolean();
			case 'array':
				return this.convertArray(schema);
			case 'object':
				return this.convertObject(schema);
			default:
				return z.any();
		}
	}

	private convertString(schema: JsonSchema): z.ZodString {
		let s = z.string();
		switch (schema.format) {
			case 'uuid':
				s = s.uuid();
				break;
			case 'uri':
			case 'url':
				s = s.url();
				break;
			case 'email':
				s = s.email();
				break;
			case 'date-time':
				s = s.datetime();
				break;
		}
		if (schema.minLength !== undefined) s = s.min(schema.minLength);
		if (schema.maxLength !== undefined) s = s.max(schema.maxLength);
		return s;
	}

	private convertNumber(schema: JsonSchema): z.ZodNumber {
		let n = z.number();
		if (schema.type === 'integer') n = n.int();
		if (schema.minimum !== undefined) n = n.min(schema.minimum);
		if (schema.maximum !== undefined) n = n.max(schema.maximum);
		return n;
	}

	private convertArray(schema: JsonSchema): z.ZodArray<z.ZodTypeAny> {
		const items = schema.items ? this.convertType(schema.items) : z.any();
		let array = z.array(items);
		// Why: the API refuses an over-long batch with a 400; carrying the
		// bound into the tool schema lets the client refuse it before the
		// round trip, and documents the limit where the tool is described.
		if (typeof schema.minItems === 'number' && Number.isInteger(schema.minItems) && schema.minItems >= 0) {
			array = array.min(schema.minItems);
		}
		if (typeof schema.maxItems === 'number' && Number.isInteger(schema.maxItems) && schema.maxItems >= 0) {
			array = array.max(schema.maxItems);
		}
		return array;
	}

	private convertObject(schema: JsonSchema): z.ZodTypeAny {
		if (!schema.properties) {
			return z.record(z.string(), z.any());
		}

		const shape: Record<string, z.ZodTypeAny> = {};
		const requiredFields = new Set(schema.required || []);
		for (const [key, propSchema] of Object.entries(schema.properties)) {
			shape[key] = this.convertToZod(propSchema, requiredFields.has(key));
		}
		return z.object(shape);
	}

	private mergeAllOf(schemas: JsonSchema[]): z.ZodTypeAny {
		const mergedProperties: Record<string, JsonSchema> = {};
		const mergedRequired: string[] = [];

		for (const schema of schemas) {
			if (schema.properties) {
				Object.assign(mergedProperties, schema.properties);
			}
			if (schema.required) {
				mergedRequired.push(...schema.required);
			}
		}

		return this.convertObject({
			type: 'object',
			properties: mergedProperties,
			required: mergedRequired
		});
	}
}
