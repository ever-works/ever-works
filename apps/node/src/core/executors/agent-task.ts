import { statSync } from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import type {
	FleetAgentModelExecution,
	FleetAgentTaskGitResult,
	FleetAgentTaskModelResult,
	FleetAgentTaskPayload,
	FleetAgentTaskResult,
	FleetAgentTaskStep,
	FleetJobView,
	FleetTaskWorkspaceDescriptor,
	FleetTaskWorkspaceSpec,
	TaskCheckResult
} from '@ever-works/contracts';
import {
	FLEET_AGENT_TASK_MAX_STEPS,
	FleetAgentExecutionError,
	normalizeFleetAgentModelExecution
} from '@ever-works/contracts';
import {
	normalizeChecks,
	runNodeCommandStep,
	type AcceptanceChecksIo,
	type NodeCheckResult,
	type WireCheck
} from './acceptance-checks';
import {
	buildModelCliCommand,
	buildModelCliStep,
	ModelCliCommandError,
	parseModelCliResult,
	type ModelCliPaths
} from './model-cli';

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
 * ## Two execution modes, one runner
 *
 * **Legacy `steps`** — the platform hands the node ordered shell
 * commands (rendered from the operator's `FLEET_NODE_AGENT_TASK_COMMAND`
 * template) and the node reports each exit code. Byte-for-byte the
 * behaviour this kind shipped with.
 *
 * **`execution` (agent execution v2)** — the platform hands the node the
 * agent's assembled instructions and the node runs a LOCAL model CLI
 * (Claude Code / Codex) on them inside the task's isolated worktree,
 * then grades the dispatch-frozen acceptance checks, then commits and
 * pushes the task branch. The model loop happens on the PC, with the
 * PC's own CLI login; only the outcome travels back. See `model-cli.ts`.
 *
 * Both modes spawn through the SAME command runner
 * (`runNodeCommandStep`), so the env scrub, the timeout policy, the
 * cancellation path and the verdict rules cannot drift between them —
 * or between this kind and `acceptance-checks`.
 *
 * ## Failure posture
 *
 * A job with nothing to run — no `execution` and no `steps` — is FAILED,
 * naming the operator knob that would have supplied them. Reporting
 * success for a job that did nothing would recreate, one layer down,
 * exactly the silent-empty-queue failure this kind exists to remove.
 */

/** Overall verdict for one `agent-task` job. */
export type AgentTaskStatus = 'succeeded' | 'failed';

/** What the node reports for one `agent-task` job — the shared wire contract. */
export type AgentTaskOutcome = FleetAgentTaskResult;

export class AgentTaskPayloadError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AgentTaskPayloadError';
	}
}

/** Commit subject when the job names none. */
export function defaultAgentTaskCommitMessage(taskId: string): string {
	return `feat(task): ${taskId} agent run output`;
}

/** Filesystem seam for the model step's scratch files. */
export interface AgentTaskScratchFs {
	mkdir(path: string): Promise<void>;
	writeFile(path: string, content: string): Promise<void>;
	/** Null when the file does not exist. */
	readFile(path: string): Promise<string | null>;
	remove(path: string): Promise<void>;
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
	/**
	 * Commit + push adapter over the provisioned worktree. Absent means the
	 * node cannot finalize a repository run; a job that asked for a commit
	 * then fails naming the gap rather than silently leaving work behind.
	 */
	finalizeWorkspace?: (
		taskId: string,
		descriptor: FleetTaskWorkspaceDescriptor,
		opts: { commitMessage: string; push: boolean },
		signal?: AbortSignal
	) => Promise<{ pushed: boolean; headSha: string | null; empty: boolean; changedFiles?: number }>;
	/** Model CLIs this node may drive, resolved once at startup. */
	modelCli?: ModelCliPaths;
	/** Root for per-job scratch files (instructions / CLI output). */
	scratchRoot?: string;
	scratchFs?: AgentTaskScratchFs;
	platform?: NodeJS.Platform;
}

/**
 * Run one `agent-task` job to a reported verdict.
 *
 * Throws only on a payload the node CANNOT honour (no task id, nothing
 * to run, a workspace that does not resolve, a model CLI it does not
 * have). A step that exits nonzero, times out or cannot be spawned is a
 * normal result — that is a verdict the platform asked for, not an
 * error in the node.
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

	const execution = resolveExecution(payload);
	const steps = normalizeAgentTaskSteps(payload.steps);
	if (!execution && steps.length === 0) {
		throw new AgentTaskPayloadError(
			'Fleet agent-task job carries no executable steps and no model execution. ' +
				'Set FLEET_NODE_AGENT_TASK_COMMAND on the platform, or switch the fleet runtime to model-cli execution.'
		);
	}
	const checks = resolveAcceptanceChecks(payload);

	const workspaceResolution = await resolveAgentTaskWorkspace(taskId, payload, io, signal);
	throwIfAgentTaskAborted(signal);

	const failures: string[] = [];
	let model: FleetAgentTaskModelResult | null = null;
	if (execution) {
		model = await runModelStep(job.id, execution, workspaceResolution.path, io, signal);
		throwIfAgentTaskAborted(signal);
		if (model.status !== 'succeeded') {
			failures.push(describeModelFailure(model));
		}
	}

	const stepResults: NodeCheckResult[] = [];
	for (const step of steps) {
		throwIfAgentTaskAborted(signal);
		stepResults.push(await runNodeCommandStep(step, workspaceResolution.path, io, signal));
		throwIfAgentTaskAborted(signal);
	}
	const anyRequiredStepFailed = steps.some(
		(step, index) => step.required !== false && stepResults[index].status !== 'green'
	);
	if (anyRequiredStepFailed) {
		failures.push('a required command step did not pass');
	}

	const checkResults: NodeCheckResult[] = [];
	for (const check of checks) {
		throwIfAgentTaskAborted(signal);
		checkResults.push(await runNodeCommandStep(check, workspaceResolution.path, io, signal));
		throwIfAgentTaskAborted(signal);
	}
	const gateStatus: 'green' | 'red' | 'none' =
		checks.length === 0
			? 'none'
			: checks.some((check, index) => check.required !== false && checkResults[index].status !== 'green')
				? 'red'
				: 'green';
	if (gateStatus === 'red') {
		failures.push('a required acceptance check did not pass');
	}

	let git: FleetAgentTaskGitResult | null = null;
	const wantsCommit = payload.git?.commit !== false;
	if (execution && workspaceResolution.descriptor && wantsCommit) {
		git = await finalizeWorkspace(taskId, workspaceResolution.descriptor, payload, io, signal);
		if (git.error) {
			failures.push(`git finalize failed: ${git.error}`);
		}
	}
	throwIfAgentTaskAborted(signal);

	return {
		status: failures.length === 0 ? 'succeeded' : 'failed',
		taskId,
		runId,
		workspace: workspaceResolution.descriptor,
		steps: stepResults,
		...(execution ? { model } : {}),
		...(checks.length > 0 ? { checks: checkResults } : {}),
		gateStatus,
		...(git ? { git } : {}),
		...(failures.length > 0 ? { failureReason: failures.join('; ') } : {})
	};
}

function resolveExecution(payload: FleetAgentTaskPayload): FleetAgentModelExecution | null {
	if (payload.execution === undefined || payload.execution === null) {
		return null;
	}
	try {
		return normalizeFleetAgentModelExecution(payload.execution);
	} catch (error) {
		if (error instanceof FleetAgentExecutionError) {
			throw new AgentTaskPayloadError(error.message);
		}
		throw error;
	}
}

function resolveAcceptanceChecks(payload: FleetAgentTaskPayload): WireCheck[] {
	if (payload.acceptanceChecks === undefined || payload.acceptanceChecks === null) {
		return [];
	}
	try {
		return normalizeChecks(payload.acceptanceChecks);
	} catch (error) {
		throw new AgentTaskPayloadError(
			`Job payload acceptanceChecks are malformed: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * The model-CLI step: write the instructions to scratch, run the CLI
 * through the shared command runner with stdin/stdout redirected onto
 * scratch files, parse what it wrote. Scratch is removed afterwards,
 * best-effort — the worktree itself is never touched by this function.
 */
async function runModelStep(
	jobId: string,
	execution: FleetAgentModelExecution,
	workspacePath: string,
	io: AgentTaskIo,
	signal?: AbortSignal
): Promise<FleetAgentTaskModelResult> {
	const executable = io.modelCli?.[execution.provider];
	if (typeof executable !== 'string' || !executable.trim()) {
		throw new AgentTaskPayloadError(
			`This node has no ${execution.provider} CLI configured — install it, or point ` +
				`${execution.provider === 'codex' ? 'EVER_WORKS_NODE_CODEX_PATH / --codex-path' : 'EVER_WORKS_NODE_CLAUDE_PATH / --claude-path'} at it`
		);
	}
	const scratchFs = io.scratchFs ?? defaultScratchFs;
	const scratchDir = join(io.scratchRoot ?? defaultScratchRoot(), scratchDirName(jobId));
	const scratch = {
		instructionsPath: join(scratchDir, 'instructions.md'),
		resultPath: join(scratchDir, 'model-output.json')
	};
	await scratchFs.mkdir(scratchDir);
	try {
		await scratchFs.writeFile(scratch.instructionsPath, execution.instructions);
		let command: string;
		try {
			command = buildModelCliCommand({
				execution,
				executable,
				workspacePath,
				scratch,
				...(io.platform ? { platform: io.platform } : {})
			});
		} catch (error) {
			if (error instanceof ModelCliCommandError) throw new AgentTaskPayloadError(error.message);
			throw error;
		}
		const step = buildModelCliStep(execution, command, execution.envPassthrough);
		const result = await runNodeCommandStep(step, workspacePath, io, signal);
		const rawOutput = await scratchFs.readFile(scratch.resultPath);
		return parseModelCliResult(execution.provider, rawOutput, result);
	} finally {
		try {
			await scratchFs.remove(scratchDir);
		} catch {
			// Scratch cleanup is best-effort: a leftover file must never fail
			// a run whose verdict is already known.
		}
	}
}

async function finalizeWorkspace(
	taskId: string,
	descriptor: FleetTaskWorkspaceDescriptor,
	payload: FleetAgentTaskPayload,
	io: AgentTaskIo,
	signal?: AbortSignal
): Promise<FleetAgentTaskGitResult> {
	const base: FleetAgentTaskGitResult = {
		branch: descriptor.branch,
		baseSha: descriptor.baseSha,
		headSha: null,
		empty: false,
		pushed: false
	};
	if (!io.finalizeWorkspace) {
		return { ...base, error: 'this node has no workspace finalizer configured' };
	}
	const commitMessage =
		typeof payload.git?.commitMessage === 'string' && payload.git.commitMessage.trim()
			? payload.git.commitMessage.trim()
			: defaultAgentTaskCommitMessage(taskId);
	try {
		const finalized = await io.finalizeWorkspace(
			taskId,
			descriptor,
			{ commitMessage, push: payload.git?.push !== false },
			signal
		);
		return {
			...base,
			headSha: finalized.headSha,
			empty: finalized.empty,
			pushed: finalized.pushed,
			...(finalized.changedFiles === undefined ? {} : { changedFiles: finalized.changedFiles })
		};
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') throw error;
		return { ...base, error: error instanceof Error ? error.message : String(error) };
	}
}

function describeModelFailure(model: FleetAgentTaskModelResult): string {
	switch (model.status) {
		case 'timeout':
			return `${model.provider} timed out`;
		case 'error':
			return `${model.provider} could not be started`;
		default:
			return model.summary
				? `${model.provider} reported an error: ${model.summary.slice(0, 200)}`
				: `${model.provider} exited with code ${model.exitCode ?? 'unknown'}`;
	}
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

/** Per-job scratch directory name — the job id is a uuid, but never trust the wire. */
function scratchDirName(jobId: string): string {
	const safe = jobId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
	return safe || 'job';
}

/** Default scratch root: the OS temp dir, namespaced to this node. */
export function defaultScratchRoot(): string {
	return join(tmpdir(), 'ever-works-node', 'agent-tasks');
}

const defaultScratchFs: AgentTaskScratchFs = {
	mkdir: (path) => fs.mkdir(path, { recursive: true }).then(() => undefined),
	writeFile: (path, content) => fs.writeFile(path, content, { encoding: 'utf8' }),
	readFile: async (path) => {
		try {
			return await fs.readFile(path, { encoding: 'utf8' });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	},
	remove: (path) => fs.rm(path, { recursive: true, force: true })
};

function throwIfAgentTaskAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	const error = new Error(reason instanceof Error ? reason.message : 'Fleet agent task was cancelled');
	error.name = 'AbortError';
	throw error;
}

// Re-exported so the result shape is reachable from the executor barrel.
export type { TaskCheckResult as AgentTaskStepResult };
