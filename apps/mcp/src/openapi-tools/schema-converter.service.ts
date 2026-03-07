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
		return z.array(items);
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
