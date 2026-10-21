import {
	FLEET_FILES_CAPABILITY,
	FLEET_FILES_LIMITS,
	FLEET_FILES_MESSAGES,
	FLEET_FILES_ROOTS_VERB,
	FLEET_FILES_STALL_TIMEOUT_MS,
	FLEET_LINK_FRAME_KINDS,
	asFleetLinkRequest,
	encodeFleetLinkAck,
	makeFleetLinkError,
	parseFleetFilesOpenParams,
	sanitizeFleetFilesWritePolicy,
	type FleetFileRootsResult,
	type FleetLinkCloseReason,
	type FleetLinkError,
	type FleetLinkFrameKind
} from '@ever-works/contracts';
import type { AllowedRoot } from '../allowed-roots';
import type { FilesIo } from './files/files-io';
import { findConflicts, describeFileEntry, listFolder } from './files/list';
import { scanSelection, streamSelection, type FilesStreamSink } from './files/pack';
import { deleteEntries } from './files/delete';
import {
	describeFileRoots,
	findFileRoot,
	FilesRequestError,
	isAcceptableFileName,
	LEAVES_ROOT_HINT,
	resolveFolder
} from './files/path-guard';
import { Unpacker } from './files/unpack';
import type { MachineVerb, NodeChannelContext, NodeChannelHandler, NodeModule } from './registry';

/**
 * Files on computers (FL-11, plan §6, T-07) — the node's `files` module
 * (CONTRACTS R-40: one module file, one entry in the runtime's list):
 *
 *  - the **`files` tag** under `--manage` while at least one allowed root
 *    exists (FR-4) — the count is refreshed in the background and on every
 *    roots call, because a module's tags are read synchronously;
 *  - the **`files.roots` machine verb** — the allowed roots (R-18, R-39,
 *    R-41: ready checkouts, the workspace root, `--files-root` folders; never
 *    the home directory), re-resolved per call;
 *  - the **`files` channel family**, one channel per request or transfer,
 *    opened with `{ root, path }` and re-proved here (`path-guard.ts`):
 *    `files.list` · `files.stat` · `files.conflicts` · `files.pack` (the
 *    files stream out, under `ACK` credit) · `files.unpack` (the stream in,
 *    into a partial folder) · `files.delete`.
 *
 * `--manage` is checked by the link's channel table before this family is
 * asked (FL-02 registry) and the family needs it by contract. While the kill
 * switch has the link paused (`link.pause`, R-24) every request is refused
 * `kill_switch` and a running transfer is stopped at once — its partial
 * folder removed (FR-23). Transfers are FL-02 operations: the node allocates
 * the id, reports progress, and `operation.cancel` stops it.
 */

export interface FilesLinkModuleOptions {
	io: FilesIo;
	/** The allowed roots, purpose `files` (`resolveCanonicalAllowedRoots`), read per request. */
	roots(): Promise<{ roots: readonly AllowedRoot[]; refused?: readonly unknown[] }>;
	nodeName: string;
	/** How often the cached root count behind the `files` tag is refreshed (0: never). */
	refreshMs?: number;
}

export interface FilesLinkModule extends NodeModule {
	/** Re-resolve the roots now (the tag follows). */
	refreshRoots(): Promise<number>;
	/** Stop the background refresh. */
	stop(): void;
}

const KILL_SWITCH_HINT = 'All computers are stopped — clear it under Settings → Fleet';
const PROGRESS_EVERY_MS = 1_000;

function firstLine(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0].slice(0, 300);
}

function asLinkError(error: unknown): FleetLinkError {
	if (error instanceof FilesRequestError) return error.toLinkError();
	return makeFleetLinkError('operation_failed', firstLine(error));
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const units = ['KB', 'MB', 'GB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Sends records as `DATA` against the link's credit; waits for `ACK` (or a close) when out of it. */
class CreditSink implements FilesStreamSink {
	private wake: (() => void) | null = null;

	constructor(
		private readonly context: NodeChannelContext,
		private readonly signal: AbortSignal
	) {
		signal.addEventListener('abort', () => this.drained(), { once: true });
	}

	drained(): void {
		const wake = this.wake;
		this.wake = null;
		wake?.();
	}

	async send(record: Uint8Array): Promise<void> {
		const deadline = Date.now() + FLEET_FILES_STALL_TIMEOUT_MS;
		while (!this.context.sendBinary(FLEET_LINK_FRAME_KINDS.DATA, record)) {
			if (this.signal.aborted) throw new FilesRequestError('operation_failed', 'cancelled');
			if (Date.now() > deadline) throw new FilesRequestError('operation_failed', 'the receiver stopped reading');
			await new Promise<void>((resolve) => {
				this.wake = resolve;
				const timer = setTimeout(resolve, 5_000);
				timer.unref?.();
			});
		}
	}
}

type Active =
	| { kind: 'pack'; abort: AbortController; operationId: string | null; sink: CreditSink | null }
	| { kind: 'unpack'; unpacker: Unpacker; operationId: string; finishing: boolean }
	| { kind: 'request' };

class FilesChannel {
	private active: Active | null = null;
	private closed = false;
	private readonly unsubscribe: () => void;
	private lastProgressAt = 0;

	constructor(
		private readonly context: NodeChannelContext,
		private readonly io: FilesIo,
		private readonly root: AllowedRoot,
		private readonly folderReal: string,
		private readonly relFolder: string
	) {
		this.unsubscribe = context.control.onChange((state) => {
			if (state.paused) this.stop('kill_switch', KILL_SWITCH_HINT);
		});
	}

	handler(): NodeChannelHandler {
		return {
			onJson: (message) => void this.onJson(message),
			onBinary: (kind, payload) => this.onBinary(kind, payload),
			onDrain: () => {
				if (this.active?.kind === 'pack') this.active.sink?.drained();
			},
			onClose: (reason) => this.onClosed(reason)
		};
	}

	private reply(requestId: string, outcome: { result: unknown } | { error: FleetLinkError }): void {
		if (!this.closed) this.context.sendJson({ requestId, ...outcome });
	}

	private async onJson(message: Record<string, unknown>): Promise<void> {
		const request = asFleetLinkRequest(message);
		if (!request) return;
		const params = request.params ?? {};
		if (this.context.control.paused) {
			this.reply(request.requestId, { error: makeFleetLinkError('kill_switch', KILL_SWITCH_HINT) });
			return;
		}
		if (this.active) {
			this.reply(request.requestId, {
				error: makeFleetLinkError('busy', 'this channel is already moving files; open another')
			});
			return;
		}
		try {
			switch (request.type) {
				case FLEET_FILES_MESSAGES.list:
					await this.simple(request.requestId, () =>
						listFolder(this.io, this.root, this.folderReal, this.relFolder, {
							hidden: params.hidden === true
						})
					);
					return;
				case FLEET_FILES_MESSAGES.stat:
					await this.simple(request.requestId, async () => {
						if (!isAcceptableFileName(params.name, this.io.platform)) {
							throw new FilesRequestError('invalid', LEAVES_ROOT_HINT);
						}
						const entry = await describeFileEntry(
							this.io,
							this.root,
							this.folderReal,
							this.relFolder,
							params.name
						);
						if (!entry) throw new FilesRequestError('not_found', `${params.name} is gone`);
						return { entry };
					});
					return;
				case FLEET_FILES_MESSAGES.conflicts:
					await this.simple(request.requestId, async () => ({
						conflicts: await findConflicts(this.io, this.folderReal, this.names(params.names))
					}));
					return;
				case FLEET_FILES_MESSAGES.delete:
					await this.simple(request.requestId, async () => ({
						...(await deleteEntries(this.io, this.folderReal, this.names(params.entries))),
						entries: Array.isArray(params.entries) ? params.entries.length : 0
					}));
					return;
				case FLEET_FILES_MESSAGES.pack:
					await this.pack(request.requestId, params);
					return;
				case FLEET_FILES_MESSAGES.unpack:
					await this.unpack(request.requestId, params);
					return;
				default:
					this.reply(request.requestId, {
						error: makeFleetLinkError('invalid', `unknown request ${request.type}`)
					});
			}
		} catch (error) {
			this.reply(request.requestId, { error: asLinkError(error) });
		}
	}

	/** Names off the wire: every one a plain name this machine accepts, or the request is refused. */
	private names(value: unknown): string[] {
		if (!Array.isArray(value)) throw new FilesRequestError('invalid', 'entries');
		if (value.length > FLEET_FILES_LIMITS.maxEntries) {
			throw new FilesRequestError('limit_exceeded', 'Select fewer than 5,000 items');
		}
		for (const name of value) {
			if (!isAcceptableFileName(name, this.io.platform)) throw new FilesRequestError('invalid', LEAVES_ROOT_HINT);
		}
		return value as string[];
	}

	private async simple(requestId: string, run: () => Promise<unknown>): Promise<void> {
		this.active = { kind: 'request' };
		try {
			this.reply(requestId, { result: await run() });
		} catch (error) {
			this.reply(requestId, { error: asLinkError(error) });
		} finally {
			if (this.active?.kind === 'request') this.active = null;
		}
	}

	private progress(operationId: string, bytes: number, total: number | null, force = false): void {
		const now = Date.now();
		if (!force && now - this.lastProgressAt < PROGRESS_EVERY_MS) return;
		this.lastProgressAt = now;
		const percent = total && total > 0 ? Math.min(100, Math.floor((bytes / total) * 100)) : undefined;
		this.context.operations.progress(operationId, {
			...(percent !== undefined ? { percent } : {}),
			message: total ? `${formatBytes(bytes)} of ${formatBytes(total)}` : formatBytes(bytes)
		});
	}

	// ─── files.pack ────────────────────────────────────────────────────────

	private async pack(requestId: string, params: Record<string, unknown>): Promise<void> {
		const names = this.names(params.entries);
		const abort = new AbortController();
		const active: Extract<Active, { kind: 'pack' }> = { kind: 'pack', abort, operationId: null, sink: null };
		this.active = active;
		let scan;
		try {
			scan = await scanSelection(this.io, this.root, this.folderReal, this.relFolder, names, abort.signal);
		} catch (error) {
			this.active = null;
			this.reply(requestId, { error: asLinkError(error) });
			return;
		}
		// A check before a download (the web's "Download" press): what would move, nothing streamed.
		if (params.dryRun === true) {
			this.active = null;
			this.reply(requestId, {
				result: {
					accepted: {
						entries: scan.entries,
						bytes: scan.bytes,
						skippedLinks: scan.skippedLinks,
						skippedOther: scan.skippedOther,
						single: scan.items.length === 1 && scan.items[0].header.kind === 'file'
					},
					credentialShaped: scan.credentialShaped,
					credentialShapedCount: scan.credentialShapedCount
				}
			});
			return;
		}
		if (scan.credentialShapedCount > 0 && params.allowCredentialShaped !== true) {
			this.active = null;
			this.reply(requestId, {
				error: makeFleetLinkError(
					'confirmation_required',
					'This looks like a credential file. Download it anyway?',
					{
						class: 'confirm',
						credentialShaped: scan.credentialShaped,
						count: scan.credentialShapedCount
					}
				)
			});
			return;
		}
		if (abort.signal.aborted || this.closed) {
			this.active = null;
			return;
		}
		const operationId = this.context.operations.start(() => abort.abort());
		active.operationId = operationId;
		const sink = new CreditSink(this.context, abort.signal);
		active.sink = sink;
		const single = scan.items.length === 1 && scan.items[0].header.kind === 'file';
		this.reply(requestId, {
			result: {
				operationId,
				accepted: {
					entries: scan.entries,
					bytes: scan.bytes,
					skippedLinks: scan.skippedLinks,
					skippedOther: scan.skippedOther,
					single,
					...(single ? { name: scan.items[0].header.path } : {})
				}
			}
		});
		try {
			const sent = await streamSelection(this.io, scan, sink, abort.signal, (progress) =>
				this.progress(operationId, progress.bytes, scan.bytes)
			);
			const summary = {
				entries: sent.entries,
				bytes: sent.bytes,
				skippedLinks: scan.skippedLinks,
				skippedOther: scan.skippedOther
			};
			this.context.sendJson({ type: FLEET_FILES_MESSAGES.packed, operationId, ...summary });
			this.context.sendBinary(FLEET_LINK_FRAME_KINDS.END, new Uint8Array(0));
			this.progress(operationId, sent.bytes, scan.bytes, true);
			this.context.operations.done(operationId, { result: summary });
		} catch (error) {
			const linkError = abort.signal.aborted
				? makeFleetLinkError('operation_failed', 'cancelled')
				: asLinkError(error);
			this.context.operations.done(operationId, { error: linkError });
			if (!this.closed) this.context.close(abort.signal.aborted ? 'normal' : linkError.code, linkError.hint);
		} finally {
			if (this.active === active) this.active = null;
		}
	}

	// ─── files.unpack ──────────────────────────────────────────────────────

	private async unpack(requestId: string, params: Record<string, unknown>): Promise<void> {
		const expectedBytes = typeof params.expectedBytes === 'number' ? params.expectedBytes : 0;
		const expectedEntries = typeof params.expectedEntries === 'number' ? params.expectedEntries : 0;
		if (expectedEntries > FLEET_FILES_LIMITS.maxEntries) {
			throw new FilesRequestError('limit_exceeded', 'Select fewer than 5,000 items');
		}
		if (expectedBytes > FLEET_FILES_LIMITS.maxOpBytes) {
			throw new FilesRequestError('limit_exceeded', 'One transfer moves at most 2 GiB — select less', {
				maxBytes: FLEET_FILES_LIMITS.maxOpBytes
			});
		}
		const operationId = this.context.operations.start(() => void this.stop('normal', 'cancelled'));
		const unpacker = new Unpacker({
			io: this.io,
			destReal: this.folderReal,
			operationId,
			policy: sanitizeFleetFilesWritePolicy(params.policy),
			ack: (bytes) => {
				const ack = encodeFleetLinkAck(bytes);
				if (ack && !this.closed) this.context.sendBinary(FLEET_LINK_FRAME_KINDS.ACK, ack);
			},
			onProgress: (progress) => this.progress(operationId, progress.bytes, expectedBytes || null),
			onFail: (error) => void this.failUnpack(error)
		});
		const active: Extract<Active, { kind: 'unpack' }> = { kind: 'unpack', unpacker, operationId, finishing: false };
		this.active = active;
		try {
			await unpacker.start();
		} catch (error) {
			this.active = null;
			const linkError = makeFleetLinkError(
				'operation_failed',
				`The destination is not writable: ${firstLine(error)}`
			);
			this.context.operations.done(operationId, { error: linkError });
			this.reply(requestId, { error: linkError });
			return;
		}
		this.reply(requestId, { result: { operationId, accepted: true } });
	}

	private onBinary(kind: FleetLinkFrameKind, payload: Uint8Array): void {
		const active = this.active;
		if (active?.kind !== 'unpack' || active.finishing) return;
		if (kind === FLEET_LINK_FRAME_KINDS.DATA) {
			active.unpacker.push(payload);
			return;
		}
		if (kind === FLEET_LINK_FRAME_KINDS.END) {
			active.finishing = true;
			void this.finishUnpack(active);
		}
	}

	private async finishUnpack(active: Extract<Active, { kind: 'unpack' }>): Promise<void> {
		try {
			const result = await active.unpacker.finish();
			this.context.sendJson({ type: FLEET_FILES_MESSAGES.unpacked, operationId: active.operationId, ...result });
			this.context.operations.done(active.operationId, { result });
		} catch (error) {
			await active.unpacker.abort();
			const linkError = asLinkError(error);
			this.context.sendJson({
				type: FLEET_FILES_MESSAGES.unpacked,
				operationId: active.operationId,
				error: linkError
			});
			this.context.operations.done(active.operationId, { error: linkError });
		} finally {
			if (this.active === active) this.active = null;
		}
	}

	private async failUnpack(error: FilesRequestError): Promise<void> {
		const active = this.active;
		if (active?.kind !== 'unpack' || active.finishing) return;
		active.finishing = true;
		await active.unpacker.abort();
		const linkError = error.toLinkError();
		this.context.sendJson({
			type: FLEET_FILES_MESSAGES.unpacked,
			operationId: active.operationId,
			error: linkError
		});
		this.context.operations.done(active.operationId, { error: linkError });
		if (this.active === active) this.active = null;
		if (!this.closed) this.context.close(linkError.code, linkError.hint);
	}

	/** Kill switch, an `operation.cancel`: stop what runs and close the channel. */
	private stop(reason: FleetLinkCloseReason, hint: string): void {
		if (this.closed) return;
		this.abortActive(reason);
		this.context.close(reason, hint);
	}

	private abortActive(reason: FleetLinkCloseReason): void {
		const active = this.active;
		this.active = null;
		if (!active) return;
		if (active.kind === 'pack') {
			active.abort.abort();
			return;
		}
		if (active.kind === 'unpack' && !active.finishing) {
			active.finishing = true;
			void active.unpacker.abort();
			this.context.operations.done(active.operationId, {
				error:
					reason === 'normal'
						? makeFleetLinkError('operation_failed', 'cancelled')
						: makeFleetLinkError(reason, 'the transfer was stopped; nothing partial was left')
			});
		}
	}

	private onClosed(reason: FleetLinkCloseReason): void {
		if (this.closed) return;
		this.abortActive(reason);
		this.closed = true;
		this.unsubscribe();
	}
}

export function createFilesLinkModule(options: FilesLinkModuleOptions): FilesLinkModule {
	const { io, nodeName } = options;
	let rootCount = 0;
	const refreshRoots = async (): Promise<number> => {
		try {
			rootCount = (await options.roots()).roots.length;
		} catch {
			rootCount = 0;
		}
		return rootCount;
	};
	void refreshRoots();
	const refreshMs = options.refreshMs ?? 60_000;
	const timer = refreshMs > 0 ? setInterval(() => void refreshRoots(), refreshMs) : null;
	timer?.unref?.();

	const rootsVerb: MachineVerb = {
		stateChanging: false,
		run: async (): Promise<FleetFileRootsResult> => {
			const resolved = await options.roots();
			rootCount = resolved.roots.length;
			return {
				platform: io.platform,
				separator: io.platform === 'win32' ? '\\' : '/',
				roots: describeFileRoots(resolved.roots, io.platform),
				refused: resolved.refused?.length ?? 0
			};
		}
	};

	return {
		id: 'files',
		tags: (environment) => (environment.consents.manage && rootCount > 0 ? [FLEET_FILES_CAPABILITY] : []),
		families: [
			{
				family: 'files',
				open: async (context) => {
					if (context.control.paused) {
						return { ok: false, error: makeFleetLinkError('kill_switch', KILL_SWITCH_HINT) };
					}
					const params = parseFleetFilesOpenParams(context.params);
					if (!params) return { ok: false, error: makeFleetLinkError('invalid', LEAVES_ROOT_HINT) };
					const resolved = await options.roots();
					const root = findFileRoot(resolved.roots, params.root, io.platform);
					if (!root) {
						return {
							ok: false,
							error: makeFleetLinkError('not_found', `That folder is no longer shared on ${nodeName}`)
						};
					}
					try {
						const folderReal = await resolveFolder(io, root, params.path);
						return {
							ok: true,
							handler: new FilesChannel(context, io, root, folderReal, params.path).handler()
						};
					} catch (error) {
						return { ok: false, error: asLinkError(error) };
					}
				}
			}
		],
		machineVerbs: { [FLEET_FILES_ROOTS_VERB]: rootsVerb },
		refreshRoots,
		stop: () => {
			if (timer) clearInterval(timer);
		}
	};
}

export { createNodeFilesIo, type FilesIo } from './files/files-io';
