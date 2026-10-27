import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ToolRegistrationService } from '../src/openapi-tools/tool-registration.service.js';
import { OpenApiLoaderService, type OpenApiOperation } from '../src/openapi-tools/openapi-loader.service.js';
import { SchemaConverterService } from '../src/openapi-tools/schema-converter.service.js';
import { ApiClientService } from '../src/api-client/api-client.service.js';
import { McpConfigService } from '../src/config/mcp-config.service.js';
import { WHITELIST } from '../src/openapi-tools/whitelist.js';
import { MCP_PRIVILEGED_TOOLS } from '../src/openapi-tools/privileged-tools.js';

/**
 * APW-01 T19 + chat and MCP parity (lane B1, 2026-10-27) — the App Works MCP surface.
 *
 * The decision per route is `docs/specs/features/app-works/contracts/agent-surfaces.md` §3.2
 * (D-D named this file). Four things are pinned:
 *
 *   1. the exact App Works entries — (method, path, toolName) is what an MCP client binds to;
 *   2. reads carry `readOnlyHint`, and every state-changing App tool is held back by
 *      `MCP_PRIVILEGED_TOOLS` (off unless the operator turns it on);
 *   3. the human-only gates on otherwise usable routes are not arguments — "Sync anyway"
 *      (`confirmWorkflowChanges` / `workflowHeadSha`), a cluster change (`confirmClusterChange`)
 *      and destroying stored data (`deleteData` / `confirmSlug`) — asserted on the generated
 *      schema AND on the handler fed raw arguments;
 *   4. the R-32 human-only routes have NO entry at all.
 */

type Entry = { method: string; path: string; toolName: string };

const READS: Entry[] = [
	{ method: 'POST', path: '/api/works/app-source/inspect', toolName: 'inspect_app_source' },
	{ method: 'GET', path: '/api/works/{id}/app-status', toolName: 'get_app_status' },
	{ method: 'GET', path: '/api/works/{id}/app-deployments', toolName: 'list_app_deployments' },
	{ method: 'GET', path: '/api/works/{id}/app-logs/{requestId}', toolName: 'get_app_logs' },
	{ method: 'GET', path: '/api/works/{id}/app-target', toolName: 'get_app_target' },
	{ method: 'GET', path: '/api/works/{id}/app-deletion-preview', toolName: 'get_app_deletion_preview' },
	{ method: 'GET', path: '/api/works/{id}/builds', toolName: 'list_app_builds' },
	{ method: 'GET', path: '/api/works/{id}/builds/{buildId}', toolName: 'get_app_build' },
	{ method: 'GET', path: '/api/works/{id}/app-env', toolName: 'get_app_env' },
	{ method: 'GET', path: '/api/works/{id}/app-dependencies', toolName: 'list_app_dependencies' },
	{ method: 'GET', path: '/api/works/{id}/app-spec', toolName: 'get_app_spec' },
	{ method: 'GET', path: '/api/works/{id}/app-license', toolName: 'get_app_license' },
	{ method: 'GET', path: '/api/apps-catalog', toolName: 'list_app_catalog_entries' },
	{ method: 'GET', path: '/api/apps-catalog/blueprints', toolName: 'list_app_blueprints' },
	{ method: 'GET', path: '/api/apps-catalog/licenses', toolName: 'list_app_licenses' },
	{ method: 'GET', path: '/api/apps-catalog/{id}', toolName: 'get_app_catalog_entry' },
	{ method: 'GET', path: '/api/works/{id}/provisioning', toolName: 'get_app_provisioning' },
	{ method: 'GET', path: '/api/works/{id}/evolve', toolName: 'list_app_changes' },
	{ method: 'GET', path: '/api/works/{id}/upstream', toolName: 'get_app_upstream' }
];

/** Change nothing about the app, its data or its spend; always on. */
const READ_SHAPED: Entry[] = [
	{ method: 'POST', path: '/api/works/{id}/app-status/refresh', toolName: 'refresh_app_status' },
	{ method: 'POST', path: '/api/works/{id}/app-logs', toolName: 'request_app_logs' },
	{ method: 'POST', path: '/api/works/{id}/app-spec/validate', toolName: 'validate_app_spec' }
];

/** State-changing: registered only with `MCP_PRIVILEGED_TOOLS=true`. */
const PRIVILEGED: Entry[] = [
	{ method: 'POST', path: '/api/works/{id}/app-smoke', toolName: 'run_app_smoke' },
	{ method: 'POST', path: '/api/works/{id}/app-rollback', toolName: 'rollback_app' },
	{ method: 'POST', path: '/api/works/{id}/app-lifecycle', toolName: 'change_app_lifecycle' },
	{ method: 'POST', path: '/api/works/{id}/builds/{buildId}/cancel', toolName: 'cancel_app_build' },
	{ method: 'POST', path: '/api/works/{id}/provision/cancel', toolName: 'cancel_app_provisioning' },
	{ method: 'POST', path: '/api/works/{id}/app-spec/blueprint', toolName: 'apply_app_blueprint' },
	{ method: 'POST', path: '/api/works/{id}/app-spec/blueprint/upgrade', toolName: 'upgrade_app_blueprint' },
	{
		method: 'POST',
		path: '/api/works/{id}/app-spec/blueprint/dismiss',
		toolName: 'dismiss_app_blueprint_upgrade'
	},
	{ method: 'POST', path: '/api/works/{id}/upstream/sync', toolName: 'sync_app_upstream' },
	{ method: 'POST', path: '/api/works/{id}/upstream/readiness/retry', toolName: 'retry_app_readiness' }
];

const ALL: Entry[] = [...READS, ...READ_SHAPED, ...PRIVILEGED];

/**
 * R-32 human-only routes (agent-surfaces.md §3.2 and §5): spending, a security posture, a secret
 * input, a legal act or data destruction. None of them is a tool, whatever the switch.
 */
const HUMAN_ONLY: Array<{ method: string; path: string }> = [
	{ method: 'POST', path: '/api/works/{id}/builds' },
	{ method: 'PUT', path: '/api/works/{id}/builds/pull-token' },
	{ method: 'POST', path: '/api/works/{id}/deploy' },
	{ method: 'POST', path: '/api/works/{id}/app-jobs/{name}/run' },
	{ method: 'POST', path: '/api/works/{id}/provision' },
	{ method: 'PUT', path: '/api/works/{id}/app-env' },
	{ method: 'POST', path: '/api/works/{id}/app-env/import-preview' },
	{ method: 'POST', path: '/api/works/{id}/app-env/{name}/rotate' },
	{ method: 'PUT', path: '/api/works/{id}/app-dependencies/{kind}' },
	{ method: 'POST', path: '/api/works/{id}/app-dependencies/{kind}/provision' },
	{ method: 'DELETE', path: '/api/works/{id}/app-dependencies/{kind}' },
	{ method: 'PUT', path: '/api/works/{id}/app-target' },
	{ method: 'POST', path: '/api/works/{id}/app-target/check' },
	{ method: 'POST', path: '/api/works/{id}/app-license/attest' },
	{ method: 'POST', path: '/api/works/{id}/upstream-pr' }
];

const find = (method: string, path: string) =>
	WHITELIST.filter((entry) => entry.method === method && entry.path === path);

describe('App Works MCP whitelist (APW-01 T19, lane B1)', () => {
	it('lists exactly 32 App Works entries, each once, under its own tool name', () => {
		expect(ALL).toHaveLength(32);
		for (const { method, path, toolName } of ALL) {
			const matches = find(method, path);
			expect(matches, `${method} ${path}`).toHaveLength(1);
			expect(matches[0].toolName, `${method} ${path}`).toBe(toolName);
			expect(WHITELIST.filter((entry) => entry.toolName === toolName)).toHaveLength(1);
		}
	});

	it('has no App Works entry beyond the 32 — a new one must be classified here first', () => {
		// Every App Works route family: the inspect, the per-Work App routes, Builds, upstream,
		// provisioning, change requests and the Apps catalog.
		const APP_WORKS_PATH =
			/^\/api\/(works\/app-source\/|works\/\{id\}\/(app-[a-z-]+|builds|upstream|provision|provisioning|evolve|deploy)(\/|$)|apps-catalog(\/|$))/;
		const actual = WHITELIST.filter((entry) => APP_WORKS_PATH.test(entry.path))
			.map((entry) => `${entry.method} ${entry.path} ${entry.toolName}`)
			.sort();
		const expected = ALL.map(({ method, path, toolName }) => `${method} ${path} ${toolName}`).sort();
		expect(actual).toEqual(expected);
	});

	it('marks every read read-only, and nothing else', () => {
		for (const { toolName } of READS) {
			const entry = WHITELIST.find((candidate) => candidate.toolName === toolName);
			expect(entry?.annotations?.readOnlyHint, toolName).toBe(true);
		}
		for (const { toolName } of [...READ_SHAPED, ...PRIVILEGED]) {
			const entry = WHITELIST.find((candidate) => candidate.toolName === toolName);
			expect(entry?.annotations?.readOnlyHint, toolName).toBeFalsy();
		}
		expect(
			WHITELIST.find((candidate) => candidate.toolName === 'change_app_lifecycle')?.annotations?.destructiveHint
		).toBe(true);
	});

	it('holds back every state-changing App tool, and no read', () => {
		for (const { toolName } of PRIVILEGED) {
			expect(MCP_PRIVILEGED_TOOLS[toolName], toolName).toEqual(expect.any(String));
		}
		for (const { toolName } of [...READS, ...READ_SHAPED]) {
			expect(MCP_PRIVILEGED_TOOLS[toolName], toolName).toBeUndefined();
		}
	});

	it('omits the human-only flags of otherwise usable routes', () => {
		const omits = (toolName: string) =>
			WHITELIST.find((candidate) => candidate.toolName === toolName)?.omitArgs ?? [];
		expect(omits('sync_app_upstream')).toEqual(
			expect.arrayContaining(['confirmWorkflowChanges', 'workflowHeadSha'])
		);
		expect(omits('rollback_app')).toEqual(expect.arrayContaining(['confirmClusterChange']));
		expect(omits('apply_app_blueprint')).toEqual(expect.arrayContaining(['confirmForkMatch']));
		expect(omits('change_app_lifecycle')).toEqual(expect.arrayContaining(['deleteData', 'confirmSlug']));
	});

	it.each(HUMAN_ONLY)('has no entry for the human-only route $method $path', ({ method, path }) => {
		expect(find(method, path)).toEqual([]);
	});
});

// ── The enforcement: the generated schema and the handler ───────────────────────────────

const op = (
	operationId: string,
	method: string,
	path: string,
	properties: Record<string, unknown>
): OpenApiOperation => ({
	operationId,
	method,
	path,
	summary: operationId,
	pathParams: [{ name: 'id', required: true, schema: { type: 'string' } }],
	queryParams: [],
	requestBody: { type: 'object', properties }
});

/** The routes as `apps/api` publishes them (DTO / `@ApiBody` schemas). */
const operations: OpenApiOperation[] = [
	op('AppUpstreamController_syncUpstream', 'POST', '/api/works/{id}/upstream/sync', {
		confirmWorkflowChanges: { type: 'boolean' },
		workflowHeadSha: { type: 'string' }
	}),
	op('WorkAppRuntimeController_rollbackApp', 'POST', '/api/works/{id}/app-rollback', {
		deploymentId: { type: 'string' },
		runPreDeployJobs: { type: 'boolean' },
		confirmClusterChange: { type: 'boolean' }
	}),
	op('WorkAppRuntimeController_lifecycleApp', 'POST', '/api/works/{id}/app-lifecycle', {
		action: { type: 'string', enum: ['pause', 'resume', 'remove', 'cancel-deploy'] },
		deleteData: { type: 'boolean' },
		confirmSlug: { type: 'string' }
	}),
	op('WorkAppOpsController_requestLogs', 'POST', '/api/works/{id}/app-logs', {
		component: { type: 'string' },
		job: { type: 'string' },
		lines: { type: 'integer' }
	}),
	op('WorkAppOpsController_runSmoke', 'POST', '/api/works/{id}/app-smoke', {})
];

describe('App Works MCP tools — what is offered and what is forwarded', () => {
	let registry: { registerTool: ReturnType<typeof vi.fn> };
	let apiClient: ApiClientService;
	const previousSwitch = process.env.MCP_PRIVILEGED_TOOLS;

	afterEach(() => {
		if (previousSwitch === undefined) delete process.env.MCP_PRIVILEGED_TOOLS;
		else process.env.MCP_PRIVILEGED_TOOLS = previousSwitch;
	});

	function register(privileged: boolean) {
		if (privileged) process.env.MCP_PRIVILEGED_TOOLS = 'true';
		else delete process.env.MCP_PRIVILEGED_TOOLS;
		const config = { apiUrl: 'http://localhost:3100/api', apiKey: 'ew_test_key' } as McpConfigService;
		apiClient = new ApiClientService(config);
		const loader = { getOperations: vi.fn(() => operations) } as unknown as OpenApiLoaderService;
		registry = { registerTool: vi.fn() };
		new ToolRegistrationService(loader, new SchemaConverterService(), apiClient, registry as never).registerTools();
	}

	function tool(name: string) {
		const call = registry.registerTool.mock.calls.find((c: unknown[]) => (c[0] as { name: string }).name === name);
		return call?.[0] as
			| {
					parameters: z.ZodObject<Record<string, z.ZodTypeAny>>;
					handler: (args: Record<string, unknown>) => Promise<unknown>;
			  }
			| undefined;
	}

	beforeEach(() => {
		registry = { registerTool: vi.fn() };
	});

	it('registers the read-shaped log request but no state-changing App tool while the switch is off', () => {
		register(false);
		expect(tool('request_app_logs')).toBeDefined();
		for (const name of ['sync_app_upstream', 'rollback_app', 'change_app_lifecycle', 'run_app_smoke']) {
			expect(tool(name), name).toBeUndefined();
		}
	});

	it('offers the log target arguments the @ApiBody now publishes', () => {
		register(false);
		expect(Object.keys(tool('request_app_logs')!.parameters.shape)).toEqual(
			expect.arrayContaining(['id', 'component', 'job', 'lines'])
		);
	});

	it('"Sync anyway" is neither offered nor forwarded, even with the switch on', async () => {
		register(true);
		const sync = tool('sync_app_upstream')!;
		const shape = Object.keys(sync.parameters.shape);
		expect(shape).not.toContain('confirmWorkflowChanges');
		expect(shape).not.toContain('workflowHeadSha');

		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ queued: true });
		await sync.handler({ id: 'work-1', confirmWorkflowChanges: true, workflowHeadSha: 'abcdef1' });
		expect(requestSpy).toHaveBeenCalledWith('POST', '/works/work-1/upstream/sync', undefined);
	});

	it('a rollback never carries the cluster-change confirmation', async () => {
		register(true);
		const rollback = tool('rollback_app')!;
		expect(Object.keys(rollback.parameters.shape)).not.toContain('confirmClusterChange');

		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ status: 'accepted' });
		await rollback.handler({ id: 'work-1', deploymentId: 'dep-1', confirmClusterChange: true });
		expect(requestSpy).toHaveBeenCalledWith('POST', '/works/work-1/app-rollback', { deploymentId: 'dep-1' });
	});

	it('a remove never deletes stored data', async () => {
		register(true);
		const lifecycle = tool('change_app_lifecycle')!;
		const shape = Object.keys(lifecycle.parameters.shape);
		expect(shape).toContain('action');
		expect(shape).not.toContain('deleteData');
		expect(shape).not.toContain('confirmSlug');

		const requestSpy = vi.spyOn(apiClient, 'request').mockResolvedValue({ status: 'accepted' });
		await lifecycle.handler({ id: 'work-1', action: 'remove', deleteData: true, confirmSlug: 'my-app' });
		expect(requestSpy).toHaveBeenCalledWith('POST', '/works/work-1/app-lifecycle', { action: 'remove' });
	});
});
