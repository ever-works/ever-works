import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { McpConfigService } from '../config/mcp-config.service.js';
import SwaggerParser from '@apidevtools/swagger-parser';
import type { JsonSchema, OpenApiParam } from './schema-converter.service.js';

export interface OpenApiOperation {
	operationId: string;
	method: string;
	path: string;
	summary?: string;
	description?: string;
	pathParams: OpenApiParam[];
	queryParams: OpenApiParam[];
	requestBody?: JsonSchema;
}

interface OpenApiSpec {
	paths?: Record<string, PathItem>;
	[key: string]: unknown;
}

interface PathItem {
	parameters?: ParameterObject[];
	get?: OperationObject;
	post?: OperationObject;
	put?: OperationObject;
	delete?: OperationObject;
	patch?: OperationObject;
}

interface ParameterObject {
	name: string;
	in: string;
	required?: boolean;
	schema?: JsonSchema;
	description?: string;
}

interface OperationObject {
	operationId?: string;
	summary?: string;
	description?: string;
	parameters?: ParameterObject[];
	requestBody?: {
		content?: {
			'application/json'?: {
				schema?: JsonSchema;
			};
		};
	};
}

@Injectable()
export class OpenApiLoaderService implements OnModuleInit {
	private readonly logger = new Logger(OpenApiLoaderService.name);
	private operations: OpenApiOperation[] = [];

	constructor(@Inject(McpConfigService) private readonly config: McpConfigService) {}

	async onModuleInit() {
		await this.loadSpec();
	}

	getOperations(): OpenApiOperation[] {
		return this.operations;
	}

	private async loadSpec() {
		const url = `${this.config.apiUrl}/openapi.json`;

		let spec: OpenApiSpec;
		try {
			spec = await this.fetchAndDereference(url);
		} catch (error) {
			// Why: this runs in onModuleInit, so a transient API hiccup at boot
			// (k8s rolling deploy, cold start) would otherwise crash the MCP
			// server permanently. Single retry with a 3s pause is a deliberate
			// floor — long enough for a rollout to swap the upstream pod, short
			// enough that boot doesn't appear hung. If the retry also fails we
			// rethrow and Nest aborts startup so the process is restarted clean.
			this.logger.warn(`First attempt to load OpenAPI spec failed, retrying in 3s: ${String(error)}`);
			await new Promise((resolve) => setTimeout(resolve, 3000));
			spec = await this.fetchAndDereference(url);
		}

		this.operations = this.extractOperations(spec);
		this.logger.log(`Loaded ${this.operations.length} operations from OpenAPI spec`);
	}

	private async fetchAndDereference(url: string): Promise<OpenApiSpec> {
		// Why: 15s covers a cold-started API serving a dereferenced OpenAPI
		// doc that can be hundreds of KB; well above the typical hot-path
		// response, but short enough to surface a hung upstream during boot.
		const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!response.ok) {
			throw new Error(`Failed to fetch OpenAPI spec: HTTP ${response.status}`);
		}
		const rawSpec = (await response.json()) as Record<string, unknown>;
		return (await SwaggerParser.dereference(rawSpec as never)) as unknown as OpenApiSpec;
	}

	private extractOperations(spec: OpenApiSpec): OpenApiOperation[] {
		const operations: OpenApiOperation[] = [];
		const paths = spec.paths || {};

		for (const [path, pathItem] of Object.entries(paths)) {
			if (!pathItem) continue;

			for (const method of ['get', 'post', 'put', 'delete', 'patch'] as const) {
				const operation = pathItem[method];
				if (!operation) continue;

				const pathParams: OpenApiParam[] = [];
				const queryParams: OpenApiParam[] = [];

				const allParams = [...(pathItem.parameters || []), ...(operation.parameters || [])];
				for (const param of allParams) {
					const paramInfo: OpenApiParam = {
						name: param.name,
						required: param.in === 'path' ? true : (param.required ?? false),
						schema: param.schema || { type: 'string' },
						description: param.description
					};
					if (param.in === 'path') {
						pathParams.push(paramInfo);
					} else if (param.in === 'query') {
						queryParams.push(paramInfo);
					}
				}

				let requestBody: JsonSchema | undefined;
				if (operation.requestBody) {
					const content = operation.requestBody.content?.['application/json'];
					if (content?.schema) {
						requestBody = content.schema;
					}
				}

				operations.push({
					operationId: operation.operationId || `${method}_${path}`,
					method: method.toUpperCase(),
					path,
					summary: operation.summary,
					description: operation.description,
					pathParams,
					queryParams,
					requestBody
				});
			}
		}

		return operations;
	}
}
