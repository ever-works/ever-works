import { describe, expect, it } from 'vitest';

import * as fleet from '../index.js';
import { FLEET_AGENT_CREDENTIAL_FAMILIES } from '../fleet-agent-credentials.types.js';
import { FLEET_EXECUTION_MODES } from '../fleet-execution-preference.types.js';
import { FLEET_JOB_STATUSES } from '../fleet-jobs.types.js';
import { FLEET_NODE_KINDS } from '../fleet-node.types.js';
import { FLEET_RUNNER_STATUS_REFRESH_SEC } from '../fleet-runner-status.types.js';

/**
 * The fleet barrel declares nothing of its own (six `export *` lines), but
 * it IS how `@ever-works/contracts` reaches every fleet symbol. A dropped or
 * mistyped re-export line still compiles here and only breaks at the call
 * site in another package — a build-time failure no test would otherwise
 * catch. So the surface is pinned by name.
 *
 * Type-only exports (interfaces, unions) are deliberately NOT asserted: they
 * do not exist at runtime, so any such check would always pass.
 */

const CREDENTIAL_EXPORTS = [
	'FLEET_AGENT_CREDENTIAL_FAMILIES',
	'FLEET_AGENT_CREDENTIAL_ENV_NAMES',
	'resolveExclusiveAgentCredentials'
] as const;

const EXECUTION_PREFERENCE_EXPORTS = [
	'FLEET_EXECUTION_MODES',
	'DEFAULT_FLEET_EXECUTION_MODE',
	'isFleetExecutionMode',
	'isLocalExecutionMode',
	'FLEET_EXECUTION_SCOPE_TYPES',
	'QUEUED_REASON_WAITING_FOR_RUNNER',
	'resolveFleetExecutionMode',
	'decideFleetRouting'
] as const;

const JOB_EXPORTS = [
	'FLEET_JOB_STATUSES',
	'FLEET_JOB_ACTIVE_STATUSES',
	'FLEET_JOB_TERMINAL_STATUSES',
	'isFleetJobTerminal',
	'isFleetJobActive',
	'FLEET_JOB_KINDS',
	'FLEET_BROWSER_CAPABILITY',
	'FLEET_GPU_CAPABILITY',
	'isFleetJobKind',
	'FLEET_JOB_DEFAULT_LEASE_TTL_SEC',
	'FLEET_JOB_MIN_LEASE_TTL_SEC',
	'FLEET_JOB_MAX_LEASE_TTL_SEC',
	'FLEET_JOB_DEFAULT_MAX_ATTEMPTS',
	'FLEET_JOB_MAX_ATTEMPTS_CEILING',
	'FLEET_JOB_MAX_LEASE_BATCH',
	'FLEET_JOB_MAX_PAYLOAD_BYTES',
	'FLEET_JOB_MAX_RESULT_BYTES',
	'FLEET_JOB_MAX_ERROR_LENGTH',
	'FLEET_JOB_MAX_REQUIRED_CAPABILITIES',
	'clampLeaseTtlSec',
	'clampMaxAttempts',
	'nodeSatisfiesCapabilities',
	'FLEET_AGENT_TASK_MAX_STEPS',
	'isNodeBusy'
] as const;

const NODE_EXPORTS = [
	'FLEET_NODE_KINDS',
	'FLEET_ENROLLABLE_NODE_KINDS',
	'isFleetEnrollableNodeKind',
	'FLEET_NODE_STATUSES',
	'FLEET_NODE_NON_LEASABLE_STATUSES',
	'FLEET_MAX_PLATFORM_LENGTH',
	'FLEET_MAX_VERSION_LENGTH',
	'FLEET_MAX_CLI_VERSION_LENGTH',
	'FLEET_MAX_DISK_FREE_BYTES',
	'FLEET_MIN_NODE_NAME_LENGTH',
	'FLEET_MAX_NODE_NAME_LENGTH',
	'FLEET_CREDENTIAL_MIN_LENGTH',
	'FLEET_CREDENTIAL_MAX_LENGTH',
	'FLEET_DEFAULT_ENROLLMENT_TOKEN_TTL_MS',
	'FLEET_DEFAULT_NODE_OFFLINE_AFTER_MS',
	'FLEET_DEFAULT_MAX_CAPABILITY_TAGS',
	'FLEET_DEFAULT_MAX_CAPABILITY_TAG_LENGTH',
	'FLEET_MAX_CAPABILITY_TAGS_CEILING',
	'FLEET_MAX_CAPABILITY_TAG_LENGTH_CEILING',
	'FLEET_MIN_ENROLLMENT_TOKEN_TTL_MS',
	'FLEET_MIN_NODE_OFFLINE_AFTER_MS'
] as const;

/** Agent execution v2 — model CLIs on the node (`fleet-jobs.types.js`). */
const AGENT_EXECUTION_EXPORTS = [
	'FLEET_AGENT_EXECUTION_PROVIDERS',
	'DEFAULT_FLEET_AGENT_EXECUTION_PROVIDER',
	'isFleetAgentExecutionProvider',
	'FLEET_AGENT_EXECUTION_MODES',
	'DEFAULT_FLEET_AGENT_EXECUTION_MODE',
	'isFleetAgentExecutionMode',
	'FLEET_AGENT_EXECUTION_EFFORTS',
	'isFleetAgentExecutionEffort',
	'FLEET_AGENT_EXECUTION_PERMISSION_MODES',
	'DEFAULT_FLEET_AGENT_EXECUTION_PERMISSION_MODE',
	'isFleetAgentExecutionPermissionMode',
	'FLEET_AGENT_EXECUTION_DEFAULT_TIMEOUT_SEC',
	'FLEET_AGENT_EXECUTION_MIN_TIMEOUT_SEC',
	'FLEET_AGENT_EXECUTION_MAX_TIMEOUT_SEC',
	'FLEET_AGENT_EXECUTION_MAX_INSTRUCTIONS_BYTES',
	'FLEET_AGENT_EXECUTION_MAX_BUDGET_USD',
	'FLEET_AGENT_EXECUTION_MODEL_PATTERN',
	'FleetAgentExecutionError',
	'normalizeFleetAgentModelExecution'
] as const;

const RUNNER_STATUS_EXPORTS = [
	'FLEET_RUNNER_STATUS_REFRESH_SEC',
	'FLEET_RUNNER_STATUS_MIN_REFRESH_SEC',
	'FLEET_RUNNER_STATUS_MAX_REFRESH_SEC',
	'summarizeRunnerStatus'
] as const;

/** Multi-repo Task workspaces (self-build slice C, `fleet-task-workspace.types.js`). */
const WORKSPACE_EXPORTS = [
	'FLEET_TASK_WORKSPACE_MAX_MOUNTS',
	'FLEET_TASK_WORKSPACE_MOUNT_DIR_PATTERN',
	'FleetTaskWorkspaceMountError',
	'normalizeFleetTaskWorkspaceMounts',
	'isReservedMountDir'
] as const;

/** Owner question from a fleet run (self-build slice Q, `fleet-jobs.types.js`). */
const QUESTION_EXPORTS = [
	'FLEET_AGENT_TASK_META_DIR',
	'FLEET_AGENT_TASK_QUESTION_FILE',
	'FLEET_AGENT_TASK_QUESTION_MAX_FILE_BYTES',
	'FLEET_AGENT_TASK_QUESTION_MAX_TEXT_CHARS',
	'FLEET_AGENT_TASK_QUESTION_MAX_CONTEXT_BYTES',
	'parseFleetAgentTaskQuestionMarkdown',
	'normalizeFleetAgentTaskQuestion'
] as const;

const ALL_EXPORTS = [
	...CREDENTIAL_EXPORTS,
	...EXECUTION_PREFERENCE_EXPORTS,
	...JOB_EXPORTS,
	...AGENT_EXECUTION_EXPORTS,
	...NODE_EXPORTS,
	...RUNNER_STATUS_EXPORTS,
	...WORKSPACE_EXPORTS,
	...QUESTION_EXPORTS
];

const FUNCTION_EXPORTS = [
	'resolveExclusiveAgentCredentials',
	'isFleetExecutionMode',
	'isLocalExecutionMode',
	'resolveFleetExecutionMode',
	'decideFleetRouting',
	'isFleetJobTerminal',
	'isFleetJobActive',
	'isFleetJobKind',
	'clampLeaseTtlSec',
	'clampMaxAttempts',
	'nodeSatisfiesCapabilities',
	'isNodeBusy',
	'isFleetEnrollableNodeKind',
	'summarizeRunnerStatus',
	'isFleetAgentExecutionProvider',
	'isFleetAgentExecutionMode',
	'isFleetAgentExecutionEffort',
	'isFleetAgentExecutionPermissionMode',
	'normalizeFleetAgentModelExecution',
	'FleetTaskWorkspaceMountError',
	'normalizeFleetTaskWorkspaceMounts',
	'isReservedMountDir',
	'parseFleetAgentTaskQuestionMarkdown',
	'normalizeFleetAgentTaskQuestion'
] as const;

const bag = fleet as unknown as Record<string, unknown>;

describe('fleet barrel', () => {
	it.each(ALL_EXPORTS.map((name) => [name]))('re-exports %s', (name) => {
		expect(Object.keys(fleet)).toContain(name);
		expect(bag[name]).toBeDefined();
	});

	it.each(FUNCTION_EXPORTS.map((name) => [name]))('re-exports %s as a function', (name) => {
		expect(typeof bag[name]).toBe('function');
	});

	it('exposes exactly these 91 runtime symbols', () => {
		// Regression guard in BOTH directions: an `export *` line deleted from
		// index.ts fails here, and a NEW runtime export added without a spec
		// also fails here — which forces the author back to cover it.
		expect(Object.keys(fleet).sort()).toEqual([...ALL_EXPORTS].sort());
		expect(Object.keys(fleet)).toHaveLength(91);
	});

	it.each([
		['fleet-agent-credentials.types.js', 'FLEET_AGENT_CREDENTIAL_FAMILIES'],
		['fleet-execution-preference.types.js', 'FLEET_EXECUTION_MODES'],
		['fleet-jobs.types.js', 'FLEET_JOB_STATUSES'],
		['fleet-node.types.js', 'FLEET_NODE_KINDS'],
		['fleet-runner-status.types.js', 'FLEET_RUNNER_STATUS_REFRESH_SEC'],
		['fleet-task-workspace.types.js', 'FLEET_TASK_WORKSPACE_MAX_MOUNTS']
	])('keeps the %s module represented via %s', (_module, sentinel) => {
		// One distinctive symbol per source module, so a whole missing
		// `export * from` line is named in the failure rather than showing up
		// only as a length mismatch.
		expect(bag[sentinel]).toBeDefined();
	});

	it('re-exports the same references rather than re-declaring them', () => {
		// `toBe`, not `toEqual`: a barrel that somehow produced copies would
		// break identity checks (and any future Object.freeze) for consumers.
		expect(fleet.FLEET_AGENT_CREDENTIAL_FAMILIES).toBe(FLEET_AGENT_CREDENTIAL_FAMILIES);
		expect(fleet.FLEET_EXECUTION_MODES).toBe(FLEET_EXECUTION_MODES);
		expect(fleet.FLEET_JOB_STATUSES).toBe(FLEET_JOB_STATUSES);
		expect(fleet.FLEET_NODE_KINDS).toBe(FLEET_NODE_KINDS);
		expect(fleet.FLEET_RUNNER_STATUS_REFRESH_SEC).toBe(FLEET_RUNNER_STATUS_REFRESH_SEC);
	});

	it('exports every name exactly once', () => {
		// Two modules exporting the same name through `export *` would silently
		// drop BOTH from the namespace in ESM; a duplicate in this list would
		// hide that, so the list itself is checked for uniqueness.
		expect(new Set(ALL_EXPORTS).size).toBe(ALL_EXPORTS.length);
	});
});
