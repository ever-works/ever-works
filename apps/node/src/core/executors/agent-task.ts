import { statSync } from 'fs';
import { isAbsolute } from 'path';
import type {
	FleetAgentTaskPayload,
	FleetAgentTaskStep,
	FleetJobView,
	FleetTaskWorkspaceDescriptor,
	FleetTaskWorkspaceSpec
} from '@ever-works/contracts';
import { FLEET_AGENT_TASK_MAX_STEPS } from '@ever-works/contracts';
import { runNodeCommandStep, type AcceptanceChecksIo, type NodeCheckResult, type WireCheck } from './acceptance-checks';

/**
 * The `agent-task` executor — the node's general job kind.
 *
 * ## Why a second kind
 *
 * `acceptance-checks` made a node capacity for the GATE. It could not
 * make it capacity for ordinary work: no matter how many machines an
 * owner enrolled, a Task's run could never land on one, because the only
 * kind the protocol knew about was "score these checks". `agent-task` is
 * the kind the agent-run dispatch path enqueues whenever the resolved
 * job runtime for the owner is the fleet.
 *
 * ## What a node can honestly execute
 *
 * A fleet node is somebody's actual machine. It has no model access, no
 * platform credentials and no inbound port, so "run the agent" cannot
 * mean "run the platform's model loop here". It means: run the ordered
 * commands the platform handed us, in a workspace, and report each exit
 * code — exactly the contract `acceptance-checks` already proved out,
 * and through the SAME command runner (`runNodeCommandStep`) so the env
 * scrub, the timeout policy and the verdict rules cannot drift between
 * the two kinds.
 *
 * ## Failure posture
 *
 * A job with no steps is FAILED, naming the operator knob that would
 * have supplied them (`FLEET_NODE_AGENT_TASK_COMMAND`). Reporting
 * success for a job that did nothing would recreate, one layer down,
 * exactly the silent-empty-queue failure this kind exists to remove.
 */

/** Overall verdict for one `agent-task` job. */
export type AgentTaskStatus = 'succeeded' | 'failed';

export interface AgentTaskOutcome extends Record<string, unknown> {
	status: AgentTaskStatus;
	/** Platform Task the steps belong to (echoed for correlation). */
	taskId: string;
	/** Platform `AgentRun` the result correlates to, when the job carried one. */
	runId: string | null;
	/** Validated repository checkout used by this run; null for legacy path-only jobs. */
	workspace: FleetTaskWorkspaceDescriptor | null;
	steps: NodeCheckResult[];
}

export class AgentTaskPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AgentTaskPayloadError';
	}
}

/** Injected so the executor is testable without spawning processes. */
export interface AgentTaskIo extends AcceptanceChecksIo {
	/** Directory used when the job carries no `workspacePath`. */
	defaultWorkspacePath?: string;
	/** Repository/worktree adapter supplied by the node composition root. */
	provisionWorkspace?: (
		taskId: string,
		spec: FleetTaskWorkspaceSpec,
		signal?: AbortSignal
	) => Promise<FleetTaskWorkspaceDescriptor>;
}

/**
 * Run one `agent-task` job to a reported verdict.
 *
 * Throws only on a payload the node CANNOT honour (no task id, no
 * executable steps, a workspace that does not resolve). A step that
 * exits nonzero, times out or cannot be spawned is a normal result —
 * that is a verdict the platform asked for, not an error in the node.
 */
export async function runAgentTaskJob(
	job: FleetJobView,
	io: AgentTaskIo = {},
	signal?: AbortSignal
): Promise<AgentTaskOutcome> {
	throwIfAgentTaskAborted(signal);
	const payload = job.payload as FleetAgentTaskPayload | null;
	if (!payload || typeof payload !== 'object') {
		throw new AgentTaskPayloadError('Job payload is missing');
	}

	const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
	if (!taskId) {
		throw new AgentTaskPayloadError('Job payload has no taskId');
	}
	const runId = typeof payload.runId === 'string' && payload.runId.trim() ? payload.runId.trim() : null;

	const steps = normalizeAgentTaskSteps(payload.steps);
	if (steps.length === 0) {
		throw new AgentTaskPayloadError(
			'Fleet agent-task job carries no executable steps. A node cannot run a model-driven agent loop; ' +
				'set FLEET_NODE_AGENT_TASK_COMMAND on the platform so it can tell this machine what to run.'
		);
	}

	const workspaceResolution = await resolveAgentTaskWorkspace(taskId, payload, io, signal);
	throwIfAgentTaskAborted(signal);

	const results: NodeCheckResult[] = [];
	for (const step of steps) {
		throwIfAgentTaskAborted(signal);
		results.push(await runNodeCommandStep(step, workspaceResolution.path, io, signal));
		throwIfAgentTaskAborted(signal);
	}

	const anyRequiredFailed = steps.some((step, index) => step.required !== false && results[index].status !== 'green');
	throwIfAgentTaskAborted(signal);
	return {
		status: anyRequiredFailed ? 'failed' : 'succeeded',
		taskId,
		runId,
		workspace: workspaceResolution.descriptor,
		steps: results
	};
}

async function resolveAgentTaskWorkspace(
	taskId: string,
	payload: FleetAgentTaskPayload,
	io: AgentTaskIo,
	signal?: AbortSignal
): Promise<{ path: string; descriptor: FleetTaskWorkspaceDescriptor | null }> {
	if (payload.workspace != null) {
		if (typeof payload.workspacePath === 'string' && payload.workspacePath.trim()) {
			throw new AgentTaskPayloadError('Fleet agent-task payload cannot carry both workspace and workspacePath');
		}
		if (!io.provisionWorkspace) {
			throw new AgentTaskPayloadError('Fleet repository workspace provisioner is not configured on this node');
		}
		const descriptor = await io.provisionWorkspace(taskId, payload.workspace, signal);
		return { path: resolveWorkspacePath(descriptor.path, io), descriptor };
	}
	return { path: resolveWorkspacePath(payload.workspacePath, io), descriptor: null };
}

/**
 * Validate the wire steps. A malformed entry is REFUSED rather than
 * skipped — silently dropping a step would report success for work that
 * never ran.
 */
export function normalizeAgentTaskSteps(raw: unknown): WireCheck[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw)) {
		throw new AgentTaskPayloadError('Job payload `steps` must be an array');
	}
	if (raw.length > FLEET_AGENT_TASK_MAX_STEPS) {
		throw new AgentTaskPayloadError(
			`Job carries ${raw.length} steps; the per-job ceiling is ${FLEET_AGENT_TASK_MAX_STEPS}`
		);
	}
	return raw.map((entry, index) => {
		if (!entry || typeof entry !== 'object') {
			throw new AgentTaskPayloadError(`Step at index ${index} is not an object`);
		}
		const step = entry as Partial<FleetAgentTaskStep> & Record<string, unknown>;
		const id = typeof step.id === 'string' ? step.id.trim() : '';
		const command = typeof step.command === 'string' ? step.command.trim() : '';
		if (!id) {
			throw new AgentTaskPayloadError(`Step at index ${index} has no id`);
		}
		if (!command) {
			throw new AgentTaskPayloadError(`Step '${id}' has no command`);
		}
		const out: WireCheck = { id, command };
		if (typeof step.cwd === 'string' && step.cwd.trim()) out.cwd = step.cwd.trim();
		if (typeof step.timeoutSec === 'number') out.timeoutSec = step.timeoutSec;
		if (typeof step.required === 'boolean') out.required = step.required;
		if (Array.isArray(step.envPassthrough)) {
			out.envPassthrough = step.envPassthrough.filter((n): n is string => typeof n === 'string');
		}
		return out;
	});
}

/**
 * Where the steps run. Unlike `acceptance-checks` (whose workspace IS
 * the checked-out Task worktree and is therefore mandatory) an agent
 * task may legitimately run where the node service was installed — so an
 * absent `workspacePath` falls back to the node's own working directory.
 * A path that IS supplied must be absolute and exist: a command that
 * runs in the wrong place is worse than a job that fails fast.
 */
function resolveWorkspacePath(supplied: unknown, io: AgentTaskIo): string {
	const candidate =
		typeof supplied === 'string' && supplied.trim() ? supplied.trim() : (io.defaultWorkspacePath ?? '').trim();
	if (!candidate) {
		return process.cwd();
	}
	if (!isAbsolute(candidate)) {
		throw new AgentTaskPayloadError('workspacePath must be an absolute path on the node');
	}
	const exists = io.directoryExists ?? defaultDirectoryExists;
	if (!exists(candidate)) {
		throw new AgentTaskPayloadError(`workspacePath does not exist on this node: ${candidate}`);
	}
	return candidate;
}

function defaultDirectoryExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function throwIfAgentTaskAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	const error = new Error(reason instanceof Error ? reason.message : 'Fleet agent task was cancelled');
	error.name = 'AbortError';
	throw error;
}
