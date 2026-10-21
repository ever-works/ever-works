import { resolve } from 'node:path';
import {
	FLEET_CHECKOUT_PATH_MAX_LENGTH,
	fleetConsentMissingHint,
	isFleetCheckoutPath,
	isFleetCheckoutSyncOp,
	makeFleetLinkError,
	type FleetCheckoutsListParams,
	type FleetCheckoutsListReply,
	type FleetCheckoutsSyncResult,
	type FleetConsents,
	type FleetNodeCheckoutRecord
} from '@ever-works/contracts';
import type { Logger } from '../../logger';
import {
	directorySize,
	scanWorkspaceRoot,
	type WorkspaceInventory
} from '../../workspaces/workspace-inventory';
import { isStrictDescendant } from '../../workspaces/fleet-task-workspace';
import {
	CHECKOUT_GIT_NETWORK_TIMEOUT_MS,
	createCheckoutGitRunner,
	redactedStderrHead,
	type CheckoutGitRunner
} from './checkouts/checkout-git';
import { isGitCheckout, readCheckoutFacts, type CheckoutFacts } from './checkouts/checkout-git-line';
import { discoverCheckouts } from './checkouts/checkout-discovery';
import {
	CheckoutRegistryStore,
	mergeDiscovery,
	type CheckoutRegistryEntry,
	type CheckoutRegistryState
} from './checkouts/checkout-registry';
import { taskCheckoutRecords } from './checkouts/checkout-task-import';
import { MachineVerbError, type MachineVerbContext, type NodeModule } from './registry';

/**
 * Checkouts on computers (FL-14, CONTRACTS §3.3 `machine` family, R-40) —
 * the node's half: one module, two verbs today.
 *
 *  - `checkouts.list { rescan?, refresh?, paths?, measureSize? }` — what this
 *    machine holds: the registry (discovered clones; P2 adds the ones Ever
 *    Works made) under `--manage`, and the node's own Task worktrees under
 *    `--work` or `--manage` (spec U2: a `--work`-only node still lists those,
 *    CONTRACTS `FLEET_LINK_VERB_CONSENT_OVERRIDES`). `rescan` runs discovery
 *    over the code folders and needs `--manage`, checked HERE whatever the
 *    platform asked. `refresh` recomputes git lines; nothing in a list ever
 *    contacts a remote (spec FR-10).
 *  - `checkouts.sync { path, op, checkoutId? }` — `fetch` (P1) on a checkout
 *    the registry holds, with the machine's own git configuration and login
 *    (spec FR-23: a discovered checkout is the owner's clone). Task worktrees
 *    are refused: their runs keep them in sync, and the pool's per-repository
 *    lock is not this module's to take.
 *
 * The node acts only on a path its own registry (or its Task pool) holds;
 * a path the platform made up is refused `not_found`. A sync in flight is
 * cancelled when the kill switch pauses the link (spec FR-30) or the
 * platform cancels the operation.
 */

export interface CheckoutsModuleOptions {
	/** `checkouts.json` beside the node's config. */
	registryPath: string;
	/** The code folders the owner listed on this machine (`--code-folder`), absolute. */
	codeFolders: readonly string[];
	/** The Task pool's root, when this node keeps one. */
	workspaceRoot: string | null;
	/** The consents this process was started with. */
	consents: FleetConsents;
	nodeName: string;
	platform?: string;
	git?: CheckoutGitRunner;
	/** Injected for specs: the pool scan (offline). */
	scanTaskWorkspaces?: (root: string, options: { measureSize: boolean; signal?: AbortSignal }) => Promise<WorkspaceInventory>;
	/** Injected for specs: bytes under a folder. */
	measure?: (path: string) => Promise<number>;
	/** The reaper's max age, for the Task worktree note. */
	reaperMaxAgeMs?: number | null;
	now?: () => number;
	logger?: Logger;
}

export interface CheckoutsModule extends NodeModule {
	/**
	 * The paths of checkouts that are `ready` on this machine right now —
	 * what the shared allowed-roots resolver reads (CONTRACTS R-39, R-41).
	 * Registry entries whose folder is there; Task worktrees are the pool's.
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
		params.paths = raw.paths
			.filter((path): path is string => isFleetCheckoutPath(path))
			.slice(0, 500);
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
	/** Last facts and size per path, so a list without `refresh` still answers the last-known line. */
	const facts = new Map<string, CheckoutFacts>();
	const sizes = new Map<string, number>();
	/** Paths with a git command running on them (sync). */
	const busy = new Map<string, string>();

	const keyOf = (path: string): string => (platform === 'win32' ? path.toLowerCase() : path);

	const loadState = async (): Promise<CheckoutRegistryState> => store.load();

	const inPool = (path: string): boolean =>
		options.workspaceRoot !== null && isStrictDescendant(options.workspaceRoot, path);

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
			throw new MachineVerbError(
				makeFleetLinkError('consent_missing', fleetConsentMissingHint('manage', context.nodeName), {
					verb: 'checkouts.list',
					consent: 'manage'
				})
			);
		}
		let state = await loadState();
		if (params.rescan) {
			const at = new Date(now()).toISOString();
			const found = await discoverCheckouts(codeFolders, { signal: context.signal, now });
			state = mergeDiscovery(state, found.paths, found.truncated, at);
			try {
				await store.save(state);
			} catch (error) {
				options.logger?.warn(
					`The checkouts registry could not be saved: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
		const wanted = params.paths ? new Set(params.paths.map(keyOf)) : null;
		const entries = manage
			? state.entries.filter((entry) => !wanted || wanted.has(keyOf(entry.path)))
			: [];
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
		return {
			checkouts: records,
			// Without --manage the registry is not reported, so the list is not the whole picture.
			complete: !params.paths && manage,
			truncated: state.truncated,
			codeFolders: manage ? codeFolders : [],
			scannedAt: state.scannedAt,
			checkoutsRoot: null
		};
	};

	const sync = async (context: MachineVerbContext): Promise<FleetCheckoutsSyncResult> => {
		const path = context.params.path;
		const op = context.params.op;
		const checkoutId =
			typeof context.params.checkoutId === 'string' && /^[0-9a-f-]{36}$/i.test(context.params.checkoutId)
				? context.params.checkoutId
				: null;
		if (!isFleetCheckoutPath(path) || path.length > FLEET_CHECKOUT_PATH_MAX_LENGTH) {
			throw new MachineVerbError(makeFleetLinkError('invalid', 'path', { field: 'path' }));
		}
		if (!isFleetCheckoutSyncOp(op)) {
			throw new MachineVerbError(makeFleetLinkError('invalid', 'op must be fetch, pull or push', { field: 'op' }));
		}
		if (op !== 'fetch') {
			throw new MachineVerbError(
				makeFleetLinkError('unsupported_on_node', `${context.nodeName} cannot ${op} checkouts yet`, {
					verb: 'checkouts.sync',
					op,
					nodeVersion: context.nodeVersion
				})
			);
		}
		const state = await loadState();
		const entry = state.entries.find((candidate) => keyOf(candidate.path) === keyOf(path));
		if (!entry) {
			if (inPool(path)) {
				throw new MachineVerbError(
					makeFleetLinkError('invalid', 'Task worktrees are kept in sync by their runs', { path })
				);
			}
			throw new MachineVerbError(
				makeFleetLinkError('not_found', `${context.nodeName} does not hold that checkout`, { path })
			);
		}
		if (!(await isGitCheckout(entry.path))) {
			throw new MachineVerbError(
				makeFleetLinkError('invalid', `The folder is gone from ${context.nodeName}`, { path })
			);
		}
		const key = keyOf(entry.path);
		if (busy.has(key)) {
			throw new MachineVerbError(
				makeFleetLinkError('busy', 'another git command is running in this checkout', {
					path,
					reason: 'operation'
				})
			);
		}
		busy.set(key, op);
		// The kill switch pauses the link: a fetch in flight is cancelled (spec FR-30).
		const abort = new AbortController();
		const onParentAbort = (): void => abort.abort();
		context.signal.addEventListener('abort', onParentAbort, { once: true });
		const stopListening = context.control.onChange((control) => {
			if (control.paused) abort.abort();
		});
		try {
			context.progress({ message: `${op} ${entry.path}` });
			const result = await git(['fetch', '--prune', 'origin'], {
				cwd: entry.path,
				signal: abort.signal,
				timeoutMs: CHECKOUT_GIT_NETWORK_TIMEOUT_MS
			});
			let record: FleetNodeCheckoutRecord | null = null;
			try {
				record = await describeEntry(entry, { refresh: true }, abort.signal);
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
		} finally {
			busy.delete(key);
			stopListening();
			context.signal.removeEventListener('abort', onParentAbort);
		}
	};

	return {
		id: 'checkouts',
		tags: () => [],
		machineVerbs: {
			'checkouts.list': { stateChanging: false, run: list },
			'checkouts.sync': { stateChanging: true, run: sync }
		},
		async readyPaths() {
			const state = await loadState();
			const ready: string[] = [];
			for (const entry of state.entries) {
				if (await isGitCheckout(entry.path)) ready.push(entry.path);
			}
			return ready;
		}
	};
}
