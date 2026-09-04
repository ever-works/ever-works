import { statSync } from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import type {
	FleetAgentModelExecution,
	FleetAgentTaskGitResult,
	FleetAgentTaskModelResult,
	FleetAgentTaskPayload,
	FleetAgentTaskQuestion,
	FleetAgentTaskResult,
	FleetAgentTaskStep,
	FleetJobView,
	FleetTaskWorkspaceDescriptor,
	FleetTaskWorkspaceMountDescriptor,
	FleetTaskWorkspaceSpec,
	TaskCheckResult
} from '@ever-works/contracts';
import type { WorkspacePublishFence } from '@ever-works/plugin';
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
	collectOwnerQuestion,
	defaultQuestionFs,
	discardOwnerQuestion,
	type AgentTaskQuestionFs
} from './agent-task-question';
import {
	assertMountGrantsInCommand,
	buildModelCliCommand,
	buildModelCliStep,
	ModelCliCommandError,
	parseModelCliResult,
	type ModelCliPaths,
	MODEL_CLI_MAX_OUTPUT_BYTES
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
 * **Owner question (self-build slice Q)** — a model that needs a decision
 * only the Task owner can make writes `.ever-works/QUESTION.md` in the
 * worktree and stops. After the model step (before the checks, before
 * any Git command) the node reads and REMOVES that file and reports it
 * as `result.question`; a stale file from an earlier attempt is
 * discarded before the model runs so only this run's words count. A
 * question is not a failure and never makes the job `failed` on its
 * own: the node still reports the model, check and git verdicts
 * honestly, and the platform decides what a paused run means. See
 * `agent-task-question.ts`.
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
	/**
	 * Create a fresh, private, UNIQUE directory under `root` for one job
	 * and return its path. The production implementation uses `mkdtemp`
	 * beneath a `0700` root: a predictable path could be pre-created as a
	 * symlink by anything sharing the temp dir, and the instructions
	 * would then be written wherever it pointed.
	 */
	createScratchDir(root: string, prefix: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
	/**
	 * Null when the file does not exist.
	 *
	 * Implementations MUST bound what they load. The model CLI's stdout is
	 * redirected here by the shell, so its size is set by the CLI, not by us
	 * — see {@link MODEL_CLI_MAX_OUTPUT_BYTES}.
	 */
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
		opts: { commitMessage: string; push: boolean; publishFence?: WorkspacePublishFence },
		signal?: AbortSignal
	) => Promise<{
		pushed: boolean;
		headSha: string | null;
		empty: boolean;
		changedFiles?: number;
		publishWithheld?: string;
	}>;
	/**
	 * Multi-repo Task workspaces (self-build slice C): commit + push adapter
	 * over the writable mounts of the provisioned workspace, one verdict per
	 * mount. Absent means the node cannot finalize mounts; a run whose
	 * workspace has writable mounts then fails naming the gap.
	 *
	 * Fenced by the same lease as the primary branch: every mount is another
	 * remote this run may no longer be entitled to write to, and a stale
	 * node publishing half a multi-repo change is worse than publishing
	 * none of it.
	 */
	finalizeMounts?: (
		taskId: string,
		descriptor: FleetTaskWorkspaceDescriptor,
		opts: { commitMessage: string; push: boolean; publishFence?: WorkspacePublishFence },
		signal?: AbortSignal
	) => Promise<
		Array<{
			repositoryId: string;
			mountDir: string;
			branch: string;
			baseSha: string;
			pushed: boolean;
			headSha: string | null;
			empty: boolean;
			changedFiles?: number;
			error?: string;
			publishWithheld?: string;
		}>
	>;
	/**
	 * The lease deadline this run is publishing under, resolved as LATE as
	 * possible — right before the commit/push — because the keep-alive
	 * advances it on every renewal and a model step outlives four or five
	 * of those. Absent on callers that hold no lease, which is exactly the
	 * shape the cloud runner has, and then the push is unfenced as before.
	 *
	 * Async because resolving it re-asks the platform whether this node
	 * still holds the claim. That question needs the network, so its answer
	 * is a bonus, not the guarantee: the deadline it returns is fenced
	 * against locally either way.
	 */
	publishFence?: () => Promise<WorkspacePublishFence | null> | WorkspacePublishFence | null;
	/**
	 * Called when the provider declined to publish. The caller decides what
	 * that means for the JOB — this executor only reports it — because a run
	 * that produced no branch has not reached a verdict anyone should record
	 * as terminal.
	 */
	onPublishWithheld?: (reason: string) => void;
	/** Model CLIs this node may drive, resolved once at startup. */
	modelCli?: ModelCliPaths;
	/** Root for per-job scratch files (instructions / CLI output). */
	scratchRoot?: string;
	scratchFs?: AgentTaskScratchFs;
	/**
	 * Self-build slice Q: reads / removes the owner-question file in the
	 * worktree (and in writable mounts). Defaults to `node:fs`.
	 */
	questionFs?: AgentTaskQuestionFs;
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

	const questionFs = io.questionFs ?? defaultQuestionFs;
	const questionMounts = (workspaceResolution.descriptor?.mounts ?? []).map((mount) => ({
		mountDir: mount.mountDir,
		path: mount.path,
		writable: mount.writable
	}));
	if (execution) {
		// The worktree is reused in place across runs (no clean, no
		// re-clone): a question file left by an aborted attempt, or by the
		// previous run whose question the owner already answered, must never
		// become a phantom question — nor context the model reads.
		await discardOwnerQuestion(workspaceResolution.path, questionFs, signal);
		for (const mount of questionMounts) {
			if (mount.writable) await discardOwnerQuestion(mount.path, questionFs, signal);
		}
		throwIfAgentTaskAborted(signal);
	}

	const failures: string[] = [];
	let model: FleetAgentTaskModelResult | null = null;
	if (execution) {
		model = await runModelStep(
			job.id,
			execution,
			workspaceResolution.path,
			workspaceResolution.descriptor?.mounts,
			io,
			signal
		);
		throwIfAgentTaskAborted(signal);
		if (model.status !== 'succeeded') {
			failures.push(describeModelFailure(model));
		}
	}

	// Self-build slice Q: read the owner question BEFORE the checks and
	// BEFORE finalize, so `git add -A` can never stage the file. A question
	// NEVER pushes to `failures` — the platform decides what a paused run
	// means, and the model / check / git verdicts below stay honest.
	let question: FleetAgentTaskQuestion | null = null;
	if (execution) {
		question = await collectOwnerQuestion(
			{ primaryPath: workspaceResolution.path, mounts: questionMounts },
			questionFs,
			signal
		);
		throwIfAgentTaskAborted(signal);
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
	let mountGit: FleetAgentTaskGitResult[] | null = null;
	const wantsCommit = payload.git?.commit !== false;
	if (execution && workspaceResolution.descriptor && wantsCommit) {
		// Resolved ONCE, here, for every publish this run makes. Late, because
		// the keep-alive advances the deadline on each renewal and a model step
		// outlives several — fencing against the value the job was leased with
		// would refuse nearly every run. Once, because the mounts and the
		// primary branch are written under the same claim and re-asking the
		// platform per repository would spend a round trip on an answer that
		// cannot have changed in between.
		const publishFence = (await io.publishFence?.()) ?? null;
		// Resolving the fence can itself learn the claim is gone and cancel
		// the run. Check before touching any repository: an abort arriving
		// here means no commit is wanted, in the mounts or the primary.
		throwIfAgentTaskAborted(signal);
		// Multi-repo (slice C): mounts first, the primary last, so the primary
		// pull request the platform opens can already link the others.
		mountGit = await finalizeMounts(taskId, workspaceResolution.descriptor, payload, io, publishFence, signal);
		for (const entry of mountGit ?? []) {
			if (entry.error) {
				failures.push(`git finalize failed for mount ${entry.mountDir ?? entry.repositoryId}: ${entry.error}`);
			} else if (entry.publishWithheld) {
				failures.push(
					`publish withheld for mount ${entry.mountDir ?? entry.repositoryId}: ${entry.publishWithheld}`
				);
				io.onPublishWithheld?.(entry.publishWithheld);
			}
		}
		git = await finalizeWorkspace(taskId, workspaceResolution.descriptor, payload, io, publishFence, signal);
		if (git.error) {
			failures.push(`git finalize failed: ${git.error}`);
		} else if (git.publishWithheld) {
			// Named apart from a git failure on purpose: nothing is broken,
			// the node declined to write a branch it may no longer own, and
			// the operator needs to read that rather than debug Git.
			failures.push(`publish withheld: ${git.publishWithheld}`);
			io.onPublishWithheld?.(git.publishWithheld);
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
		...(mountGit && mountGit.length > 0 ? { mountGit } : {}),
		// Conditional key: a run without a question reports exactly what it
		// always did (`question: null` would be a wire change for nothing).
		...(question ? { question } : {}),
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
 *
 * `mounts` comes straight from the provisioned descriptor: the CLI is
 * confined to its cwd, and a multi-repo Task's extra repositories live
 * OUTSIDE that tree (only linked into it), so they have to be granted
 * explicitly or every cross-repository edit fails silently. The built
 * command is then checked to actually carry that grant before it is
 * spawned — see {@link assertMountGrantsInCommand} for why the check
 * cannot live at provision time.
 */
async function runModelStep(
	jobId: string,
	execution: FleetAgentModelExecution,
	workspacePath: string,
	mounts: readonly FleetTaskWorkspaceMountDescriptor[] | undefined,
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
	const scratchDir = await scratchFs.createScratchDir(io.scratchRoot ?? defaultScratchRoot(), scratchDirName(jobId));
	const scratch = {
		instructionsPath: join(scratchDir, 'instructions.md'),
		resultPath: join(scratchDir, 'model-output.json')
	};
	try {
		await scratchFs.writeFile(scratch.instructionsPath, execution.instructions);
		let command: string;
		try {
			command = buildModelCliCommand({
				execution,
				executable,
				workspacePath,
				scratch,
				...(mounts && mounts.length > 0 ? { mounts } : {}),
				...(io.platform ? { platform: io.platform } : {})
			});
			// Last gate before the spawn: the grant has to be in the string
			// that is actually run, not merely computed. Nothing downstream
			// can tell a discarded cross-repository edit from a model that
			// chose not to make one, so a missing grant fails the job here.
			assertMountGrantsInCommand({
				command,
				execution,
				...(mounts && mounts.length > 0 ? { mounts } : {}),
				...(io.platform ? { platform: io.platform } : {})
			});
		} catch (error) {
			if (error instanceof ModelCliCommandError) throw new AgentTaskPayloadError(error.message);
			throw error;
		}
		const step = buildModelCliStep(execution, command, execution.envPassthrough);
		const result = await runNodeCommandStep(step, workspacePath, io, signal);
		const rawOutput = await scratchFs.readFile(scratch.resultPath);
		// `envPassthrough` names the credential env vars this CLI was handed;
		// their values are scrubbed out of the summary and output tail before
		// the result leaves the node.
		return parseModelCliResult(execution.provider, rawOutput, result, execution.envPassthrough);
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
	publishFence: WorkspacePublishFence | null,
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
			{
				commitMessage,
				push: payload.git?.push !== false,
				...(publishFence ? { publishFence } : {})
			},
			signal
		);
		return {
			...base,
			headSha: finalized.headSha,
			empty: finalized.empty,
			pushed: finalized.pushed,
			...(finalized.changedFiles === undefined ? {} : { changedFiles: finalized.changedFiles }),
			...(finalized.publishWithheld === undefined ? {} : { publishWithheld: finalized.publishWithheld })
		};
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') throw error;
		return { ...base, error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * Multi-repo (slice C): one git verdict per WRITABLE mount. `null` when the
 * workspace has no writable mounts, so single-repository runs report
 * exactly what they did before.
 */
async function finalizeMounts(
	taskId: string,
	descriptor: FleetTaskWorkspaceDescriptor,
	payload: FleetAgentTaskPayload,
	io: AgentTaskIo,
	publishFence: WorkspacePublishFence | null,
	signal?: AbortSignal
): Promise<FleetAgentTaskGitResult[] | null> {
	const writable = (descriptor.mounts ?? []).filter((mount) => mount.writable);
	if (writable.length === 0) return null;
	const toBase = (mount: (typeof writable)[number]): FleetAgentTaskGitResult => ({
		repositoryId: mount.repositoryId,
		mountDir: mount.mountDir,
		branch: mount.branch,
		baseSha: mount.baseSha,
		headSha: null,
		empty: false,
		pushed: false
	});
	if (!io.finalizeMounts) {
		return writable.map((mount) => ({ ...toBase(mount), error: 'this node has no mount finalizer configured' }));
	}
	const commitMessage =
		typeof payload.git?.commitMessage === 'string' && payload.git.commitMessage.trim()
			? payload.git.commitMessage.trim()
			: defaultAgentTaskCommitMessage(taskId);
	try {
		const results = await io.finalizeMounts(
			taskId,
			descriptor,
			{
				commitMessage,
				push: payload.git?.push !== false,
				...(publishFence ? { publishFence } : {})
			},
			signal
		);
		return results.map((result) => ({
			repositoryId: result.repositoryId,
			mountDir: result.mountDir,
			branch: result.branch,
			baseSha: result.baseSha,
			headSha: result.headSha,
			empty: result.empty,
			pushed: result.pushed,
			...(result.changedFiles === undefined ? {} : { changedFiles: result.changedFiles }),
			...(result.error ? { error: result.error } : {}),
			...(result.publishWithheld === undefined ? {} : { publishWithheld: result.publishWithheld })
		}));
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') throw error;
		const message = error instanceof Error ? error.message : String(error);
		return writable.map((mount) => ({ ...toBase(mount), error: message }));
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

/** Per-job scratch directory PREFIX — the job id is a uuid, but never trust the wire. */
function scratchDirName(jobId: string): string {
	const safe = jobId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
	return safe || 'job';
}

/** Default scratch root: the OS temp dir, namespaced to this node. */
export function defaultScratchRoot(): string {
	return join(tmpdir(), 'ever-works-node', 'agent-tasks');
}

/**
 * Production scratch filesystem. `createScratchDir` is `mkdtemp` under a
 * PRIVATE root: atomic and unique, so nothing sharing the temp dir can
 * pre-plant a symlink at the path the node is about to write to — and
 * the root itself is verified (`ensurePrivateScratchRoot`), so a link
 * planted at the root's predictable name cannot redirect the whole job
 * directory somewhere another local user controls. Exported for the
 * regression tests that prove exactly that.
 */
export const defaultScratchFs: AgentTaskScratchFs = {
	createScratchDir: async (root, prefix) => {
		const privateRoot = await ensurePrivateScratchRoot(root);
		return fs.mkdtemp(join(privateRoot, `${prefix}-`));
	},
	writeFile: (path, content) => fs.writeFile(path, content, { encoding: 'utf8', mode: 0o600 }),
	readFile: async (path) => {
		try {
			// Size the file BEFORE loading it. `buildModelCliCommand`
			// redirects the CLI's stdout straight to disk with `>`, so this
			// content never passes through Node's stdout capture and nothing
			// upstream bounds it. `MODEL_CLI_OUTPUT_TAIL_BYTES` truncates for
			// DISPLAY, but only after the whole file is already a string in
			// memory — by which point a looping or compromised CLI running up
			// to the 1800s ceiling has already exhausted the process, taking
			// every other job on this node down with it.
			//
			// Refusing beats truncating: the payload is `model-output.json`
			// and a partial read cannot be parsed anyway, so a clear failure
			// is more useful than a JSON error further down.
			const stat = await fs.stat(path);
			if (stat.size > MODEL_CLI_MAX_OUTPUT_BYTES) {
				throw new Error(
					`Model CLI output is ${stat.size} bytes; the ceiling is ${MODEL_CLI_MAX_OUTPUT_BYTES}. ` +
						'Refusing to load it — the run is failed rather than risking the node.'
				);
			}
			return await fs.readFile(path, { encoding: 'utf8' });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	},
	remove: (path) => fs.rm(path, { recursive: true, force: true })
};

/**
 * Creates the scratch root (`0700`) and refuses to use it unless it —
 * and every ancestor below the OS temp dir — is a real directory that
 * belongs to this user.
 *
 * `mkdir(root, { recursive: true })` silently follows a symlink or a
 * junction planted at any of those names: on a shared temp dir another
 * local user could point `ever-works-node/` at a directory they own,
 * watch the job directory appear there and swap it for a link before
 * the node writes the instructions file. The temp dir itself (and, for
 * an operator-chosen root outside it, the root's ancestors) is trusted:
 * whoever controls those controls the account anyway.
 *
 * On POSIX the verified directories must be owned by the current user;
 * a root that pre-exists with group/other bits (an old umask) is
 * tightened to `0700` rather than refused. Returns the absolute root.
 */
export async function ensurePrivateScratchRoot(root: string): Promise<string> {
	const absolute = resolve(root);
	await fs.mkdir(absolute, { recursive: true, mode: 0o700 });
	const uid = process.platform === 'win32' ? undefined : process.getuid?.();
	for (const dir of scratchRootComponentsToVerify(absolute)) {
		const stat = await fs.lstat(dir);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(
				`Refusing scratch root ${absolute}: ${dir} is not a real directory (a symlink or junction was planted there)`
			);
		}
		if (uid !== undefined) {
			if (stat.uid !== uid) {
				throw new Error(`Refusing scratch root ${absolute}: ${dir} is owned by another user`);
			}
			if ((stat.mode & 0o077) !== 0) await fs.chmod(dir, 0o700);
		}
	}
	return absolute;
}

/**
 * The directories `ensurePrivateScratchRoot` verifies: the root itself
 * plus each ancestor strictly below the OS temp dir when the root lives
 * there (the default), the root alone otherwise.
 */
function scratchRootComponentsToVerify(absolute: string): string[] {
	const temp = resolve(tmpdir());
	const rel = relative(temp, absolute);
	const underTemp = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
	if (!underTemp) return [absolute];
	const components: string[] = [];
	let current = absolute;
	while (!samePath(current, temp) && dirname(current) !== current) {
		components.push(current);
		current = dirname(current);
	}
	return components;
}

function samePath(a: string, b: string): boolean {
	return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function throwIfAgentTaskAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	const error = new Error(reason instanceof Error ? reason.message : 'Fleet agent task was cancelled');
	error.name = 'AbortError';
	throw error;
}

// Re-exported so the result shape is reachable from the executor barrel.
export type { TaskCheckResult as AgentTaskStepResult };
