import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { ToolRegistrationService } from '../src/openapi-tools/tool-registration.service.js';
import { OpenApiLoaderService, type OpenApiOperation } from '../src/openapi-tools/openapi-loader.service.js';
import { SchemaConverterService } from '../src/openapi-tools/schema-converter.service.js';
import { ApiClientService } from '../src/api-client/api-client.service.js';
import { McpConfigService } from '../src/config/mcp-config.service.js';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';

/**
 * APW-01 T39 (FR-40b, Resolution R-15) — **no agent can destroy stored data through
 * MCP**.
 *
 * The App Work delete surface adds two fields to `POST /api/works/{id}/delete`:
 * `delete_stored_data` (the App's volumes and App dependencies go with the Work) and
 * its typed `confirm_slug`. The route keeps them so the web dialog can use them; the
 * MCP `delete_work` tool must expose **neither as a tool argument and forward
 * neither**, so an agent driving the platform cannot reach the destructive half of
 * the route at all. Deleting the Work still works, and keeps the stored data.
 *
 * Two layers are asserted, because the whitelist entry alone is not the guarantee:
 *
 *   1. the entry lists both names in `omitArgs` (the declared intent), and
 *   2. the **generated tool schema** carries neither, and the handler drops either one
 *      even when it is handed raw, unvalidated arguments (the enforcement).
 *
 * Filed beside `whitelist-*.spec.ts` and `tool-registration.spec.ts` rather than in
 * `whitelist-app-works.spec.ts`, which T42's App Works work also extends — two
 * authors must not race on one new file in a shared worktree.
 */

type Entry = { method: string; path: string; toolName?: string; omitArgs?: string[] };

const DELETE_WORK_ENTRY: Entry = {
	method: 'POST',
	path: '/api/works/{id}/delete',
	toolName: 'delete_work'
};

/**
 * The route as `apps/api` publishes it (`DeleteWorkDto` in
 * `packages/agent/src/items-generator/dto/delete-items-generator.dto.ts`).
 */
const deleteWorkOperation: OpenApiOperation = {
	operationId: 'WorksController_deleteWork',
	method: 'POST',
	path: '/api/works/{id}/delete',
	summary: 'Delete work',
	pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
	queryParams: [],
	requestBody: {
		type: 'object',
		properties: {
			reason: { type: 'string' },
			force_delete: { type: 'boolean' },
			delete_data_repository: { type: 'boolean' },
			delete_markdown_repository: { type: 'boolean' },
			delete_website_repository: { type: 'boolean' },
			delete_stored_data: { type: 'boolean' },
			confirm_slug: { type: 'string' }
		}
	}
};

function entryFromWhitelist(): Entry {
	const entry = (WHITELIST as unknown as Entry[]).find((candidate) => candidate.toolName === 'delete_work');
	expect(entry, 'the delete_work entry is still whitelisted').toBeDefined();
	return entry!;
}

describe('delete_work — the stored-data flag is not an MCP argument', () => {
	let service: ToolRegistrationService;
	let registry: { registerTool: ReturnType<typeof vi.fn> };
	let apiClient: ApiClientService;

	beforeEach(() => {
		const config = { apiUrl: 'http://localhost:3100/api', apiKey: 'ew_test_key' } as McpConfigService;
		apiClient = new ApiClientService(config);
		const loader = {
			getOperations: vi.fn(() => [deleteWorkOperation])
		} as unknown as OpenApiLoaderService;
		registry = { registerTool: vi.fn() };
		service = new ToolRegistrationService(loader, new SchemaConverterService(), apiClient, registry as never);
	});

	function registeredDeleteWork() {
		service.registerTools();
		const call = registry.registerTool.mock.calls.find(
			(c: unknown[]) => (c[0] as { name: string }).name === 'delete_work'
		);
		expect(call, 'delete_work is registered').toBeDefined();
		return call![0] as {
			parameters: z.ZodObject<Record<string, z.ZodTypeAny>>;
			handler: (args: Record<string, unknown>) => Promise<unknown>;
		};
	}

	it('the whitelist entry omits both App delete fields', () => {
		const entry = entryFromWhitelist();

		expect(entry.omitArgs ?? []).toContain('delete_stored_data');
		expect(entry.omitArgs ?? []).toContain('confirm_slug');
		// The entry keeps its (method, path) tuple: only the arguments changed.
		expect(entry.method).toBe(DELETE_WORK_ENTRY.method);
		expect(entry.path).toBe(DELETE_WORK_ENTRY.path);
	});

	it('the generated schema carries neither field, and still carries the ordinary ones', () => {
		const { parameters } = registeredDeleteWork();
		const shape = Object.keys(parameters.shape).sort();

		expect(shape).not.toContain('delete_stored_data');
		expect(shape).not.toContain('confirm_slug');
		expect(shape).toContain('delete_data_repository');
		expect(shape).toContain('id');

		// The transport validates with `safeParse`, and a Zod object strips unknown
		// keys — so an agent that sends the flag anyway never reaches the handler.
		const parsed = parameters.safeParse({
			id: 'work-1',
			delete_data_repository: true,
			delete_stored_data: true,
			confirm_slug: 'cal-diy'
		});
		expect(parsed.success).toBe(true);
		expect(parsed.data).toEqual({ id: 'work-1', delete_data_repository: true });
	});

	it('never forwards either field upstream, even when handed raw arguments', async () => {
		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ status: 'success' });
		const { handler } = registeredDeleteWork();

		await handler({
			id: 'work-1',
			delete_data_repository: true,
			delete_stored_data: true,
			confirm_slug: 'cal-diy'
		});

		expect(requestSpy).toHaveBeenCalledWith('POST', '/works/work-1/delete', {
			delete_data_repository: true
		});
	});
});
