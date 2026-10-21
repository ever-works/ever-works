import { join, resolve, sep } from 'node:path';
import {
	FLEET_CHECKOUT_PATH_MAX_LENGTH,
	fleetConsentMissingHint,
	isFleetCheckoutBranchName,
	isFleetCheckoutCreatedBy,
	isFleetCheckoutDeleteMode,
	isFleetCheckoutPath,
	isFleetCheckoutSyncOp,
	makeFleetLinkError,
	stripFleetRemoteCredential,
	type FleetCheckoutChangesEvidence,
	type FleetCheckoutsCreateResult,
	type FleetCheckoutsDeleteResult,
	type FleetCheckoutsListParams,
	type FleetCheckoutsListReply,
	type FleetCheckoutsSyncResult,
	type FleetConsents,
	type FleetNodeCheckoutRecord
} from '@ever-works/contracts';
import type { Logger } from '../../logger';
import { directorySize, scanWorkspaceRoot, type WorkspaceInventory } from '../../workspaces/workspace-inventory';
import { isStrictDescendant } from '../../workspaces/fleet-task-workspace';
import {
	anonymousGitEnv,
	CheckoutCredentialError,
	withCheckoutCredential,
	type CheckoutCredentialClient
} from './checkouts/checkout-credential';
import { discoverCheckouts } from './checkouts/checkout-discovery';
import { evidenceGrew, isEvidenceClean, readChangesEvidence } from './checkouts/checkout-evidence';
import {
	containerRefusal,
	containerRunArgv,
	detectDocker,
	isContainerImageReference
} from './checkouts/checkout-container';
import { linkSharedFolders } from './checkouts/checkout-shared-folders';
import { createCheckoutGitRunner, redactedStderrHead, type CheckoutGitResult, type CheckoutGitRunner } from './checkouts/checkout-git';
import { isGitCheckout, readCheckoutFacts, readWorktreeMain, type CheckoutFacts } from './checkouts/checkout-git-line';
import {
	addWorktree,
	CheckoutPathTakenError,
	cloneCheckout,
	fetchCheckout,
	pullCheckout,
	pushCheckout,
	remoteBranches,
	removeCloneFolder,
	removeWorktree,
	type CheckoutOperationOptions
} from './checkouts/checkout-operations';
import {
	applyArchivedPaths,
	CheckoutRegistryStore,
	mergeDiscovery,
	removeRegistryEntry,
	upsertRegistryEntry,
	type CheckoutRegistryEntry,
	type CheckoutRegistryState
} from './checkouts/checkout-registry';
import { taskCheckoutRecords } from './checkouts/checkout-task-import';
import { MachineVerbError, type MachineVerbContext, type NodeModule } from './registry';

/**
 * Checkouts on computers (FL-14, CONTRACTS §3.3 `machine` family, R-40) —
 * the node's half: one module, four verbs.
 *
 *  - `checkouts.list { rescan?, refresh?, paths?, measureSize?, remoteHeads?,
 *    archivedPaths? }` — what this machine holds: the registry (discovered
 *    clones and the ones Ever Works made) under `--manage`, and the node's own
 *    Task worktrees under `--work` or `--manage` (spec U2). `rescan` runs
 *    discovery and needs `--manage`, checked HERE whatever the platform
 *    asked. `refresh` recomputes git lines; nothing in a list contacts a
 *    remote (FR-10) except `remoteHeads` (FL-06's flag, FR-26b), and only on
 *    request.
 *  - `checkouts.create { checkoutId, path, source, branch, baseRef, createdBy }`
 *    (P2) — a fresh clone or a worktree, at the exact path the platform
 *    named, which must sit under this node's checkouts root and not exist
 *    yet. A clone authenticates only with the operation-scoped credential the
 *    platform mints for it (FR-17); a partial folder is removed on failure.
 *  - `checkouts.sync { path, op }` — fetch, pull (fast-forward only, refused on
 *    a dirty tree, U7) and push. On a `discovered` checkout these run with the
 *    machine's own git configuration and login (FR-23); on one Ever Works
 *    made, with the scoped credential (`read` for fetch/pull, `write` for push)
 *    and never the machine's helper (U8).
 *  - `checkouts.delete { path, mode: 'preview'|'delete'|'forget', expected? }`
 *    (P2) — `preview` computes what would be lost; `delete` re-computes it and
 *    refuses when it grew past what the person confirmed, then removes the
 *    folder (a worktree through git, keeping its branch, FR-25); `forget`
 *    drops the registry entry and touches nothing on disk. A discovered
 *    checkout can only be forgotten.
 *
 * The node acts only on a path its own registry (or its Task pool) holds; a
 * path the platform made up is refused `not_found`. A command in flight is
 * cancelled when the kill switch pauses the link (FR-30) or the platform
 * cancels the operation.
 */

export interface CheckoutsModuleOptions {
	/** `checkouts.json` beside the node's config. */
	registryPath: string;
	/** The code folders the owner listed on this machine (`--code-folder`), absolute. */
	codeFolders: readonly string[];
	/** The Task pool's root, when this node keeps one. */
	workspaceRoot: string | null;
	/** Where checkouts Ever Works creates go (default `<workspaceRoot>/checkouts`); null: create is refused. */
	checkoutsRoot?: string | null;
	/** The consents this process was started with. */
	consents: FleetConsents;
	nodeName: string;
	platform?: string;
	git?: CheckoutGitRunner;
	/** The platform's scoped-credential route (P2); absent, a checkout Ever Works made cannot reach its remote. */
	credentials?: CheckoutCredentialClient;
	/** Injected for specs: the pool scan (offline). */
	scanTaskWorkspaces?: (root: string, options: { measureSize: boolean; signal?: AbortSignal }) => Promise<WorkspaceInventory>;
	/** Injected for specs: bytes under a folder. */
	measure?: (path: string) => Promise<number>;
	/** The reaper's max age, for the Task worktree note. */
	reaperMaxAgeMs?: number | null;
	/** P3: is a Docker daemon reachable (container isolation)? Default: one `docker version` call. */
	hasDocker?: () => Promise<boolean>;
	now?: () => number;
	logger?: Logger;
}

export interface CheckoutsModule extends NodeModule {
	/**
	 * P3 (spec FR-31) — FL-04's session daemon and FL-12's commands ask this
	 * before they spawn in a folder: the `docker run` argv that runs `command`
	 * inside the checkout's container when the folder is a container-isolated
	 * checkout, else null (run on the host as today).
	 */
	containerArgvFor(path: string, command: readonly string[], options?: { tty?: boolean }): Promise<string[] | null>;
	/**
	 * The paths of checkouts that are `ready` on this machine right now —
	 * what the shared allowed-roots resolver reads (CONTRACTS R-39, R-41):
	 * registry entries whose folder is there and that the platform has not
	 * put in the bin.
	 */
	readyPaths(): Promise<string[]>;
}

/** How many checkouts have their git line read at once. */
const GIT_LINE_CONCURRENCY = 4;

function parseListParams(raw: Readonly<Record<string, unknown>>): FleetCheckoutsListParams {
	const params: FleetCheckoutsListParams = {};
	if (raw.rescan === true) params.rescan = true;
	if (raw.refresh === true) params.refresh = true;
	if (raw.measureSize === true) params.measureSize = true;
	if (raw.remoteHeads === true) params.remoteHeads = true;
	if (Array.isArray(raw.paths)) {
		params.paths = raw.paths.filter((path): path is string => isFleetCheckoutPath(path)).slice(0, 500);
	}
	if (Array.isArray(raw.archivedPaths)) {
		params.archivedPaths = raw.archivedPaths
			.filter((path): path is string => isFleetCheckoutPath(path))
			.slice(0, 2000);
	}
	return params;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			out[index] = await run(items[index]);
		}
	});
	await Promise.all(workers);
	return out;
}

function refuse(code: Parameters<typeof makeFleetLinkError>[0], hint: string, details?: Record<string, unknown>): never {
	throw new MachineVerbError(makeFleetLinkError(code, hint, details));
}

export function createCheckoutsModule(options: CheckoutsModuleOptions): CheckoutsModule {
	const platform = options.platform ?? process.platform;
	const git = options.git ?? createCheckoutGitRunner(platform);
	const now = options.now ?? (() => Date.now());
	const store = new CheckoutRegistryStore(options.registryPath, (message) => options.logger?.warn(message));
	const measure = options.measure ?? directorySize;
	const scan =
		options.scanTaskWorkspaces ??
		((root: string, scanOptions: { measureSize: boolean; signal?: AbortSignal }) =>
			scanWorkspaceRoot(root, {
				refreshRemote: false,
				measureSize: scanOptions.measureSize,
				...(scanOptions.signal ? { signal: scanOptions.signal } : {})
			}));
	const codeFolders = options.codeFolders.map((folder) => resolve(folder));
	const checkoutsRoot =
		options.checkoutsRoot !== undefined
			? options.checkoutsRoot
			: options.workspaceRoot
				? join(options.workspaceRoot, 'checkouts')
				: null;
	/** Last facts and size per path, so a list without `refresh` still answers the last-known line. */
	const facts = new Map<string, CheckoutFacts>();
	const sizes = new Map<string, number>();
	/** Paths with a git command running on them. */
	const busy = new Map<string, string>();
	/** Registry writes are serialised: list, create and delete each read-modify-write the file. */
	let registryChain: Promise<unknown> = Promise.resolve();

	const keyOf = (path: string): string => (platform === 'win32' ? path.toLowerCase() : path);

	const loadState = async (): Promise<CheckoutRegistryState> => store.load();

	const updateState = (change: (state: CheckoutRegistryState) => CheckoutRegistryState | null): Promise<void> => {
		const run = registryChain.then(async () => {
			const next = change(await store.load());
			if (next) await store.save(next);
		});
		registryChain = run.catch((error: unknown) =>
			options.logger?.warn(
				`The checkouts registry could not be saved: ${error instanceof Error ? error.message : String(error)}`
			)
		);
		return run as Promise<void>;
	};

	const inPool = (path: string): boolean =>
		options.workspaceRoot !== null && isStrictDescendant(options.workspaceRoot, path);

	const findEntry = async (path: string): Promise<CheckoutRegistryEntry | undefined> => {
		const state = await loadState();
		return state.entries.find((candidate) => keyOf(candidate.path) === keyOf(path));
	};

	const operationOptions = (signal: AbortSignal, credentialEnv?: Record<string, string>): CheckoutOperationOptions => ({
		git,
		signal,
		...(credentialEnv ? { credentialEnv } : {})
	});

	/** The remote a platform-created checkout talks to (its own `origin`, token-free). */
	const remoteOf = async (path: string, signal: AbortSignal): Promise<string | null> => {
		const result = await git(['config', '--get', 'remote.origin.url'], { cwd: path, signal });
		if (result.code !== 0) return null;
		return stripFleetRemoteCredential(result.stdout.trim())?.url ?? null;
	};

	/**
	 * Run a network command on a checkout: with the operation-scoped
	 * credential when Ever Works made it (`origin: 'platform'`), with the
	 * machine's own configuration when it is the owner's clone (FR-23).
	 */
	const networked = async (
		entry: CheckoutRegistryEntry,
		access: 'read' | 'write',
		signal: AbortSignal,
		run: (operation: CheckoutOperationOptions) => Promise<CheckoutGitResult>
	): Promise<CheckoutGitResult> => {
		if (entry.origin !== 'platform') return run(operationOptions(signal));
		if (entry.anonymous) {
			// A public repository Ever Works cloned without a credential: reads stay anonymous
			// (every credential source off); a push has nothing to authenticate with (spec U8).
			if (access === 'write') {
				refuse('operation_failed', 'no credential covers this repository', {
					path: entry.path,
					hint: 'install the GitHub App on this repository, or push from a session with your own login'
				});
			}
			return run({ git, signal, credentialEnv: anonymousGitEnv() });
		}
		if (!options.credentials || !entry.checkoutId) {
			refuse('operation_failed', 'this node cannot ask the platform for a scoped credential', { path: entry.path });
		}
		const remoteUrl = await remoteOf(entry.path, signal);
		if (!remoteUrl) refuse('operation_failed', 'this checkout has no origin remote', { path: entry.path });
		try {
			return await withCheckoutCredential(
				options.credentials!,
				{ checkoutId: entry.checkoutId!, access, remoteUrl: remoteUrl!, signal },
				(env) => run(operationOptions(signal, env))
			);
		} catch (error) {
			if (error instanceof CheckoutCredentialError) {
				refuse('operation_failed', error.message, {
					path: entry.path,
					hint: 'install the GitHub App on this repository, or push from a session with your own login'
				});
			}
			throw error;
		}
	};

	const describeEntry = async (
		entry: CheckoutRegistryEntry,
		params: FleetCheckoutsListParams,
		signal: AbortSignal
	): Promise<FleetNodeCheckoutRecord> => {
		const present = await isGitCheckout(entry.path);
		const key = keyOf(entry.path);
		if (present && (params.refresh || !facts.has(key))) {
			try {
				const read = await readCheckoutFacts(entry.path, git, { signal, now });
				if (read) facts.set(key, read);
			} catch (error) {
				if (signal.aborted) throw error;
				options.logger?.warn(
					`Checkout ${entry.path}: git line unreadable (${error instanceof Error ? error.message : String(error)})`
				);
			}
		}
		if (present && params.measureSize) {
			try {
				sizes.set(key, await measure(entry.path));
			} catch {
				// Size is a nicety (spec FR-14); an unreadable tree keeps its last figure.
			}
		}
		const known = present ? facts.get(key) : undefined;
		return {
			path: entry.path,
			checkoutId: entry.checkoutId,
			kind: entry.kind,
			origin: entry.origin,
			parentPath: entry.parentPath ?? known?.mainCheckoutPath ?? null,
			remoteUrl: known?.remoteUrl ?? null,
			remoteHadCredential: known?.remoteHadCredential === true,
			branch: known?.branch ?? null,
			baseRef: known?.baseRef ?? null,
			headSha: known?.headSha ?? null,
			isolation: entry.isolation,
			present,
			gitLine: known?.gitLine ?? null,
			sizeBytes: sizes.get(key) ?? null,
			busy: busy.has(key) ? 'operation' : null,
			reaperNote: null,
			lastUsedAt: null
		};
	};

	const describeTask = async (
		record: FleetNodeCheckoutRecord,
		params: FleetCheckoutsListParams,
		signal: AbortSignal
	): Promise<FleetNodeCheckoutRecord> => {
		const key = keyOf(record.path);
		if (params.refresh || !facts.has(key)) {
			try {
				const read = await readCheckoutFacts(record.path, git, { signal, now });
				if (read) facts.set(key, read);
			} catch (error) {
				if (signal.aborted) throw error;
			}
		}
		if (record.sizeBytes !== null) sizes.set(key, record.sizeBytes);
		const known = facts.get(key);
		return {
			...record,
			branch: known?.branch ?? record.branch,
			headSha: known?.headSha ?? record.headSha,
			baseRef: known?.baseRef ?? record.baseRef,
			gitLine: known?.gitLine ?? null,
			sizeBytes: sizes.get(key) ?? null
		};
	};

	const list = async (context: MachineVerbContext): Promise<FleetCheckoutsListReply> => {
		const params = parseListParams(context.params);
		const manage = context.consents.manage;
		if (params.rescan && !manage) {
			refuse('consent_missing', fleetConsentMissingHint('manage', context.nodeName), {
				verb: 'checkouts.list',
				consent: 'manage'
			});
		}
		if (params.rescan) {
			const at = new Date(now()).toISOString();
			const found = await discoverCheckouts(codeFolders, { signal: context.signal, now });
			await updateState((state) => mergeDiscovery(state, found.paths, found.truncated, at));
		}
		if (params.archivedPaths && manage) {
			const archived = params.archivedPaths;
			await updateState((state) => applyArchivedPaths(state, archived, keyOf));
		}
		const state = await loadState();
		const wanted = params.paths ? new Set(params.paths.map(keyOf)) : null;
		const entries = manage ? state.entries.filter((entry) => !wanted || wanted.has(keyOf(entry.path))) : [];
		const records = await mapLimit(entries, GIT_LINE_CONCURRENCY, (entry) =>
			describeEntry(entry, params, context.signal)
		);
		const wantsPool =
			options.workspaceRoot !== null &&
			(context.consents.work || manage) &&
			(!params.paths || params.paths.some((path) => inPool(path)));
		if (wantsPool && options.workspaceRoot) {
			try {
				const inventory = await scan(options.workspaceRoot, {
					measureSize: params.measureSize === true,
					signal: context.signal
				});
				const tasks = taskCheckoutRecords(inventory, {
					reaperMaxAgeMs: options.reaperMaxAgeMs ?? null,
					now
				}).filter((record) => !wanted || wanted.has(keyOf(record.path)));
				const described = await mapLimit(tasks, GIT_LINE_CONCURRENCY, (record) =>
					describeTask(record, params, context.signal)
				);
				const known = new Set(records.map((record) => keyOf(record.path)));
				for (const record of described) if (!known.has(keyOf(record.path))) records.push(record);
			} catch (error) {
				if (context.signal.aborted) throw error;
				options.logger?.warn(
					`Task worktrees could not be listed: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
		const reply: FleetCheckoutsListReply = {
			checkouts: records,
			// Without --manage the registry is not reported, so the list is not the whole picture.
			complete: !params.paths && manage,
			truncated: state.truncated,
			codeFolders: manage ? codeFolders : [],
			scannedAt: state.scannedAt,
			checkoutsRoot: manage ? checkoutsRoot : null
		};
		// FL-06's flag (FR-26b): the remote's branch names for ONE registered checkout, on request only.
		if (params.remoteHeads && manage && params.paths?.length === 1) {
			const entry = entries.find((candidate) => keyOf(candidate.path) === keyOf(params.paths![0]));
			if (entry && (await isGitCheckout(entry.path))) {
				const found: { names: string[] | null } = { names: null };
				try {
					await networked(entry, 'read', context.signal, async (operation) => {
						found.names = await remoteBranches(entry.path, operation);
						return { code: found.names ? 0 : 1, stdout: '', stderr: '' };
					});
				} catch (error) {
					// Best-effort: the list itself never fails because the remote could not be asked.
					if (context.signal.aborted) throw error;
				}
				if (found.names) reply.remoteBranches = found.names;
			}
		}
		return reply;
	};

	/** Hold the path busy for one command; cancelled by the kill switch or the platform. */
	const exclusive = async <T>(
		context: MachineVerbContext,
		path: string,
		op: string,
		run: (signal: AbortSignal) => Promise<T>
	): Promise<T> => {
		const key = keyOf(path);
		if (busy.has(key)) {
			refuse('busy', 'another git command is running in this checkout', { path, reason: 'operation' });
		}
		busy.set(key, op);
		const abort = new AbortController();
		const onParentAbort = (): void => abort.abort();
		context.signal.addEventListener('abort', onParentAbort, { once: true });
		const stopListening = context.control.onChange((control) => {
			if (control.paused) abort.abort();
		});
		try {
			return await run(abort.signal);
		} finally {
			busy.delete(key);
			stopListening();
			context.signal.removeEventListener('abort', onParentAbort);
		}
	};

	const requireRegistered = async (context: MachineVerbContext, path: unknown): Promise<CheckoutRegistryEntry> => {
		if (!isFleetCheckoutPath(path) || path.length > FLEET_CHECKOUT_PATH_MAX_LENGTH) {
			refuse('invalid', 'path', { field: 'path' });
		}
		const entry = await findEntry(path as string);
		if (!entry) {
			if (inPool(path as string)) refuse('invalid', 'Task worktrees are kept in sync by their runs', { path });
			refuse('not_found', `${context.nodeName} does not hold that checkout`, { path });
		}
		return entry!;
	};

	const sync = async (context: MachineVerbContext): Promise<FleetCheckoutsSyncResult> => {
		const op = context.params.op;
		const checkoutId =
			typeof context.params.checkoutId === 'string' && /^[0-9a-f-]{36}$/i.test(context.params.checkoutId)
				? context.params.checkoutId
				: null;
		if (!isFleetCheckoutSyncOp(op)) refuse('invalid', 'op must be fetch, pull or push', { field: 'op' });
		const entry = await requireRegistered(context, context.params.path);
		if (!(await isGitCheckout(entry.path))) {
			refuse('invalid', `The folder is gone from ${context.nodeName}`, { path: entry.path });
		}
		return exclusive(context, entry.path, op, async (signal) => {
			context.progress({ message: `${op} ${entry.path}` });
			let result: CheckoutGitResult;
			if (op === 'pull') {
				// Spec FR-21, U7: refused before anything runs on a dirty tree.
				const evidence = await readChangesEvidence(entry.path, git, { signal });
				if (evidence.uncommitted > 0) {
					refuse(
						'invalid',
						`${evidence.uncommitted} uncommitted file${evidence.uncommitted === 1 ? '' : 's'} on ${context.nodeName} — commit or stash them in a session first`,
						{ path: entry.path, uncommitted: evidence.uncommitted }
					);
				}
				result = await networked(entry, 'read', signal, (operation) => pullCheckout(entry.path, operation));
			} else if (op === 'push') {
				const branch = (await readCheckoutFacts(entry.path, git, { signal, now }))?.branch ?? null;
				if (!branch) refuse('invalid', 'this checkout is not on a branch (detached HEAD); nothing to push');
				result = await networked(entry, 'write', signal, (operation) =>
					pushCheckout(entry.path, branch!, operation)
				);
			} else {
				result = await networked(entry, 'read', signal, (operation) => fetchCheckout(entry.path, operation));
			}
			let record: FleetNodeCheckoutRecord | null = null;
			try {
				record = await describeEntry(entry, { refresh: true }, signal);
			} catch {
				record = null;
			}
			return {
				path: entry.path,
				checkoutId: checkoutId ?? entry.checkoutId,
				op,
				exitCode: result.code,
				stderrHead: result.code === 0 ? null : redactedStderrHead(result.stderr),
				checkout: record
			};
		});
	};

	const create = async (context: MachineVerbContext): Promise<FleetCheckoutsCreateResult> => {
		const params = context.params;
		const createdBy = isFleetCheckoutCreatedBy(params.createdBy) ? params.createdBy : 'user';
		// The override lets `--work` through for a Task's checkout only (spec S9, U2).
		if (createdBy !== 'task' && !context.consents.manage) {
			refuse('consent_missing', fleetConsentMissingHint('manage', context.nodeName), {
				verb: 'checkouts.create',
				consent: 'manage'
			});
		}
		const checkoutId =
			typeof params.checkoutId === 'string' && /^[0-9a-f-]{36}$/i.test(params.checkoutId) ? params.checkoutId : null;
		if (!checkoutId) refuse('invalid', 'checkoutId', { field: 'checkoutId' });
		if (!checkoutsRoot) {
			refuse('unsupported_on_node', `${context.nodeName} has no folder for new checkouts (no workspace root)`, {
				verb: 'checkouts.create'
			});
		}
		const path = params.path;
		if (!isFleetCheckoutPath(path) || path.length > FLEET_CHECKOUT_PATH_MAX_LENGTH) {
			refuse('invalid', 'path', { field: 'path' });
		}
		const target = resolve(path as string);
		// Never inside the parent, never outside the checkouts root (spec FR-18).
		if (!isStrictDescendant(checkoutsRoot!, target)) {
			refuse('invalid', `new checkouts go under ${checkoutsRoot}${sep}`, { field: 'path' });
		}
		const branch = params.branch;
		if (!isFleetCheckoutBranchName(branch)) refuse('invalid', 'branch', { field: 'branch' });
		const baseRef =
			params.baseRef === null || params.baseRef === undefined
				? null
				: isFleetCheckoutBranchName(params.baseRef)
					? params.baseRef
					: refuse('invalid', 'baseRef', { field: 'baseRef' });
		const source = params.source as
			| { kind?: unknown; repoUrl?: unknown; parentPath?: unknown; credential?: unknown }
			| undefined;
		// P3 (spec FR-31, U11): container isolation is refused here — on Windows, or without Docker.
		const container = params.isolation === 'container';
		let containerImage: string | null = null;
		if (container) {
			const refusal = containerRefusal(platform, await (options.hasDocker ?? (() => detectDocker()))());
			if (refusal) refuse('unsupported_on_node', refusal, { field: 'isolation' });
			if (!isContainerImageReference(params.containerImage)) {
				refuse('invalid', 'containerImage', { field: 'containerImage' });
			}
			containerImage = params.containerImage as string;
		}
		const sharedFolders = Array.isArray(params.sharedFolders)
			? params.sharedFolders.filter((folder): folder is string => typeof folder === 'string').slice(0, 16)
			: [];
		const at = new Date(now()).toISOString();
		return exclusive(context, target, 'create', async (signal) => {
			let result: CheckoutGitResult;
			let entry: CheckoutRegistryEntry;
			try {
				if (source?.kind === 'clone') {
					const stripped = stripFleetRemoteCredential(source.repoUrl);
					if (!stripped || stripped.hadCredential) {
						refuse('invalid', 'a clone URL must be a remote, token-free URL', { field: 'repoUrl' });
					}
					const repoUrl = stripped!.url;
					// The platform decided whether an installation covers this repository (FR-17):
					// scoped credential when it does, an anonymous clone (helpers off) when it does not.
					const scoped = source.credential === true;
					entry = {
						path: target,
						kind: 'clone',
						origin: 'platform',
						checkoutId: checkoutId!,
						parentPath: null,
						isolation: container ? 'container' : 'host',
						addedAt: at,
						...(scoped ? {} : { anonymous: true }),
						...(containerImage ? { containerImage } : {})
					};
					const clone = (operation: CheckoutOperationOptions) => {
						context.progress({ percent: 20, message: 'clone' });
						return cloneCheckout({ path: target, repoUrl, branch: branch as string, baseRef }, operation);
					};
					if (scoped) {
						if (!options.credentials) {
							refuse('operation_failed', 'this node cannot ask the platform for a scoped credential');
						}
						context.progress({ percent: 5, message: 'credential' });
						try {
							result = await withCheckoutCredential(
								options.credentials!,
								{ checkoutId: checkoutId!, access: 'read', remoteUrl: repoUrl, signal },
								(env) => clone(operationOptions(signal, env))
							);
						} catch (error) {
							if (error instanceof CheckoutCredentialError) refuse('operation_failed', error.message);
							throw error;
						}
					} else {
						result = await clone({ git, signal, credentialEnv: anonymousGitEnv() });
					}
				} else if (source?.kind === 'worktree') {
					const parent = await requireRegistered(context, source.parentPath);
					if (!(await isGitCheckout(parent.path))) {
						refuse('invalid', `The folder is gone from ${context.nodeName}`, { path: parent.path });
					}
					// A worktree of a worktree hangs off the same main checkout.
					const main = await readWorktreeMain(parent.path);
					const mainPath = main.isWorktree && main.mainPath ? main.mainPath : parent.path;
					entry = {
						path: target,
						kind: 'worktree',
						origin: 'platform',
						checkoutId: checkoutId!,
						parentPath: parent.path,
						isolation: container ? 'container' : 'host',
						addedAt: at,
						...(containerImage ? { containerImage } : {})
					};
					context.progress({ percent: 20, message: 'worktree' });
					result = await addWorktree(
						{ parentPath: mainPath, path: target, branch: branch as string, baseRef },
						operationOptions(signal)
					);
					// P3 (spec FR-32): the parent's ignored folders, linked — never copied.
					if (result.code === 0 && sharedFolders.length > 0) {
						const linked = await linkSharedFolders(
							{ parentPath: parent.path, worktreePath: target, folders: sharedFolders, platform },
							git
						);
						const skipped = linked.filter((outcome) => !outcome.linked);
						if (skipped.length > 0) {
							options.logger?.warn(
								`Shared folders not linked into ${target}: ${skipped
									.map((outcome) => `${outcome.folder} (${outcome.reason})`)
									.join(', ')}`
							);
						}
					}
				} else {
					refuse('invalid', 'source must be a clone or a worktree', { field: 'source' });
				}
			} catch (error) {
				if (error instanceof CheckoutPathTakenError) {
					refuse('invalid', `${error.path} already exists on ${context.nodeName}`, {
						field: 'path',
						path: error.path
					});
				}
				throw error;
			}
			if (result.code === 0) {
				const made = entry!;
				await updateState((state) => upsertRegistryEntry(state, made));
			}
			let record: FleetNodeCheckoutRecord | null = null;
			if (result.code === 0) {
				try {
					record = await describeEntry(entry!, { refresh: true, measureSize: true }, signal);
				} catch {
					record = null;
				}
			}
			return {
				checkoutId: checkoutId!,
				path: target,
				exitCode: result.code,
				stderrHead: result.code === 0 ? null : redactedStderrHead(result.stderr),
				checkout: record
			};
		});
	};

	const remove = async (context: MachineVerbContext): Promise<FleetCheckoutsDeleteResult> => {
		const mode = context.params.mode;
		if (mode !== 'preview' && !isFleetCheckoutDeleteMode(mode)) {
			refuse('invalid', 'mode must be preview, delete or forget', { field: 'mode' });
		}
		const entry = await requireRegistered(context, context.params.path);
		const present = await isGitCheckout(entry.path);
		const empty: FleetCheckoutChangesEvidence = { uncommitted: 0, unpushedCommits: 0, hasLocks: false };
		if (mode === 'forget') {
			await updateState((state) => removeRegistryEntry(state, entry.path));
			facts.delete(keyOf(entry.path));
			return { path: entry.path, mode, evidence: empty, removed: false, branchKept: null };
		}
		if (!present) {
			// Nothing on disk to lose or remove: the row goes to the bin as "folder removed".
			if (mode === 'delete') await updateState((state) => removeRegistryEntry(state, entry.path));
			return { path: entry.path, mode, evidence: empty, removed: mode === 'delete', branchKept: null };
		}
		return exclusive(context, entry.path, 'delete', async (signal) => {
			const evidence = await readChangesEvidence(entry.path, git, { signal });
			if (mode === 'preview') {
				return { path: entry.path, mode, evidence, removed: false, branchKept: null };
			}
			if (entry.origin === 'discovery' || entry.kind === 'discovered') {
				refuse('invalid', 'a checkout found on this computer is only forgotten, never deleted', {
					path: entry.path
				});
			}
			if (evidence.hasLocks) {
				refuse('busy', 'another git command is running in this checkout', { path: entry.path, reason: 'lock' });
			}
			const expected = context.params.expected as { uncommitted?: unknown; unpushedCommits?: unknown } | undefined;
			const confirmed =
				expected && typeof expected.uncommitted === 'number' && typeof expected.unpushedCommits === 'number'
					? { uncommitted: expected.uncommitted, unpushedCommits: expected.unpushedCommits }
					: undefined;
			// Plan §6: the confirmation was given for smaller counts — refuse, never delete more than was shown.
			if (evidenceGrew(evidence, confirmed)) {
				refuse('busy', 'more would be lost now than when you confirmed — look again', {
					path: entry.path,
					uncommitted: evidence.uncommitted,
					unpushedCommits: evidence.unpushedCommits,
					clean: isEvidenceClean(evidence)
				});
			}
			let branchKept: string | null = null;
			if (entry.kind === 'worktree') {
				const main = await readWorktreeMain(entry.path);
				const read = await readCheckoutFacts(entry.path, git, { signal, now });
				branchKept = read?.branch ?? null;
				const mainPath = main.mainPath ?? entry.parentPath;
				if (!mainPath) refuse('operation_failed', 'the main checkout of this worktree could not be found');
				const result = await removeWorktree({ path: entry.path, mainPath: mainPath! }, operationOptions(signal));
				if (result.code !== 0) {
					refuse('operation_failed', redactedStderrHead(result.stderr) ?? 'git could not remove the worktree');
				}
			} else {
				// A clone Ever Works made: only ever under the checkouts root.
				if (!checkoutsRoot || !isStrictDescendant(checkoutsRoot, entry.path)) {
					refuse('invalid', 'this checkout is not under the folder Ever Works creates checkouts in', {
						path: entry.path
					});
				}
				await removeCloneFolder(entry.path);
			}
			await updateState((state) => removeRegistryEntry(state, entry.path));
			facts.delete(keyOf(entry.path));
			sizes.delete(keyOf(entry.path));
			return { path: entry.path, mode, evidence, removed: true, branchKept };
		});
	};

	return {
		id: 'checkouts',
		tags: () => [],
		machineVerbs: {
			'checkouts.list': { stateChanging: false, run: list },
			'checkouts.sync': { stateChanging: true, run: sync },
			'checkouts.create': { stateChanging: true, run: create },
			'checkouts.delete': { stateChanging: true, run: remove }
		},
		async containerArgvFor(path, command, argvOptions = {}) {
			const entry = await findEntry(path);
			if (!entry || entry.isolation !== 'container' || !entry.containerImage) return null;
			return containerRunArgv({
				path: entry.path,
				image: entry.containerImage,
				command,
				...(argvOptions.tty ? { tty: true } : {})
			});
		},
		async readyPaths() {
			const state = await loadState();
			const ready: string[] = [];
			for (const entry of state.entries) {
				if (entry.archived) continue;
				if (await isGitCheckout(entry.path)) ready.push(entry.path);
			}
			return ready;
		}
	};
}
