import { Injectable, Inject, Logger } from '@nestjs/common';
import { McpRegistryService } from '@rekog/mcp-nest';
import { OpenApiLoaderService, type OpenApiOperation } from './openapi-loader.service.js';
import { SchemaConverterService } from './schema-converter.service.js';
import { ApiClientService } from '../api-client/api-client.service.js';
import { toMcpError } from '../api-client/api-error.js';
import { WHITELIST, type WhitelistEntry } from './whitelist.js';

@Injectable()
export class ToolRegistrationService {
	private readonly logger = new Logger(ToolRegistrationService.name);

	constructor(
		@Inject(OpenApiLoaderService) private readonly loader: OpenApiLoaderService,
		@Inject(SchemaConverterService) private readonly converter: SchemaConverterService,
		@Inject(ApiClientService) private readonly apiClient: ApiClientService,
		@Inject(McpRegistryService) private readonly registry: McpRegistryService
	) {}

	registerTools() {
		const operations = this.loader.getOperations();
		const registeredNames = new Set<string>();
		let count = 0;

		for (const entry of WHITELIST) {
			const operation = this.findOperation(operations, entry);
			if (!operation) {
				this.logger.warn(`Whitelist entry ${entry.method} ${entry.path} not found in OpenAPI spec, skipping`);
				continue;
			}

			let toolName = entry.toolName || this.generateToolName(entry.method, entry.path);
			if (registeredNames.has(toolName)) {
				toolName = `${toolName}_2`;
				this.logger.warn(`Tool name collision detected, using "${toolName}"`);
			}
			registeredNames.add(toolName);

			const description =
				entry.description || operation.summary || operation.description || `${entry.method} ${entry.path}`;
			const parameters = this.converter.buildToolParameters(
				operation.pathParams,
				operation.queryParams,
				operation.requestBody
			);

			this.registry.registerTool({
				name: toolName,
				description,
				parameters,
				annotations: entry.annotations,
				handler: this.createHandler(entry, operation)
			});
			count++;
		}

		this.logger.log(`Registered ${count} MCP tools from OpenAPI spec`);
	}

	private createHandler(entry: WhitelistEntry, operation: OpenApiOperation) {
		const pathParamNames = new Set(operation.pathParams.map((p) => p.name));
		const queryParamNames = new Set(operation.queryParams.map((p) => p.name));
		const apiClient = this.apiClient;

		return async (args: Record<string, unknown>) => {
			try {
				let apiPath = entry.path;
				const queryParams = new URLSearchParams();
				const bodyParams: Record<string, unknown> = {};

				for (const [key, value] of Object.entries(args)) {
					if (pathParamNames.has(key)) {
						apiPath = apiPath.replace(`{${key}}`, encodeURIComponent(`${value as string | number}`));
					} else if (queryParamNames.has(key)) {
						if (value !== undefined && value !== null) {
							queryParams.append(key, `${value as string | number | boolean}`);
						}
					} else {
						bodyParams[key] = value;
					}
				}

				// Remove /api prefix since ApiClientService base URL already includes /api
				let requestPath = apiPath;
				if (requestPath.startsWith('/api')) {
					requestPath = requestPath.slice(4);
				}

				const queryString = queryParams.toString();
				if (queryString) {
					requestPath += `?${queryString}`;
				}

				const hasBody = Object.keys(bodyParams).length > 0;
				const result = await apiClient.request(entry.method, requestPath, hasBody ? bodyParams : undefined);

				return {
					content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }]
				};
			} catch (error) {
				return toMcpError(error);
			}
		};
	}

	private findOperation(operations: OpenApiOperation[], entry: WhitelistEntry): OpenApiOperation | undefined {
		return operations.find((op) => op.method === entry.method && this.pathsMatch(op.path, entry.path));
	}

	private pathsMatch(specPath: string, whitelistPath: string): boolean {
		const normalize = (p: string) => p.replace(/\{[^}]+\}/g, '{*}');
		return normalize(specPath) === normalize(whitelistPath);
	}

	private generateToolName(method: string, path: string): string {
		const parts = path
			.replace(/^\/api\//, '')
			.split('/')
			.filter((p) => !p.startsWith('{'));

		const name = parts.join('_').replace(/-/g, '_');
		const prefix =
			method === 'GET'
				? 'get'
				: method === 'POST'
					? 'create'
					: method === 'PUT'
						? 'update'
						: method === 'DELETE'
							? 'delete'
							: method.toLowerCase();

		return `${prefix}_${name}`;
	}
}
