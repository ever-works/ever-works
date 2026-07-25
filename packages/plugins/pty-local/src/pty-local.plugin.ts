import { spawn as spawnChild, type ChildProcess } from 'node:child_process';
import type {
	IPlugin,
	ITerminalStreamPlugin,
	JsonSchema,
	PluginCategory,
	PluginContext,
	PluginHealthCheck,
	PluginManifest,
	PluginSettings,
	TerminalSessionHandle,
	TerminalSpawnInput,
	TerminalTransport
} from '@ever-works/plugin';
import { TerminalNotProvisionedError } from '@ever-works/plugin';

/**
 * Minimal structural view of the node-pty API we use — typed locally so
 * the native package stays a RUNTIME require (never a static import:
 * bundlers would trace it and the deployed worker image may not carry
 * the prebuild; absence must degrade, not crash module load).
 */
interface PtyProcessLike {
	onData(cb: (data: string) => void): void;
	onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: string): void;
}

interface PtyModuleLike {
	spawn(
		file: string,
		args: string[],
		options: {
			cwd: string;
			env: Record<string, string>;
			cols: number;
			rows: number;
			name: string;
		}
	): PtyProcessLike;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

/**
 * `pty-local` — first-party `terminal-stream` provider.
 *
 * Runs the agent CLI in THIS process's runtime (the job-runtime worker
 * that called the facade), pumping bytes against the platform-supplied
 * transport:
 *
 *  - **PTY path**: `@homebridge/node-pty-prebuilt-multiarch` via runtime
 *    require — full interactive terminal, resizable, TUIs render.
 *  - **Pipe floor**: plain `child_process.spawn` with piped stdio when
 *    the prebuild is unavailable (bundled image without the addon,
 *    unsupported platform). No resize, but bytes still stream — the
 *    handle reports `isPty: false` so the UI shows an honest banner.
 *
 * Both paths share the same pump contract: preamble frames first, then
 * monotonically-sequenced stdout frames; inbound stdin/resize consumed
 * from the transport; the final `exit` frame is published BEFORE the
 * handle's `exited` promise resolves (a viewer must always learn the
 * session ended).
 */
export class PtyLocalPlugin implements IPlugin, ITerminalStreamPlugin {
	readonly id = 'pty-local';
	readonly name = 'Local PTY Terminal Host';
	readonly version = '1.0.0';
	readonly category: PluginCategory = 'utility';
	readonly capabilities: readonly string[] = ['terminal-stream'];
	readonly providerName = 'pty-local';

	readonly settingsSchema: JsonSchema = {
		type: 'object',
		properties: {
			defaultCols: {
				type: 'number',
				title: 'Default Columns',
				description: 'Initial terminal width when the client has not sent a resize yet.',
				default: DEFAULT_COLS
			},
			defaultRows: {
				type: 'number',
				title: 'Default Rows',
				description: 'Initial terminal height when the client has not sent a resize yet.',
				default: DEFAULT_ROWS
			}
		}
	};

	private context?: PluginContext;

	// ── ITerminalStreamPlugin ───────────────────────────────────────

	async spawn(input: TerminalSpawnInput, transport: TerminalTransport): Promise<TerminalSessionHandle> {
		if (!Array.isArray(input.command) || input.command.length === 0) {
			throw new TerminalNotProvisionedError('No command to spawn.');
		}

		for (const frame of input.preamble ?? []) {
			transport.publish(frame);
		}

		const cols = input.initialSize?.cols ?? DEFAULT_COLS;
		const rows = input.initialSize?.rows ?? DEFAULT_ROWS;
		const [file, ...args] = input.command as string[];

		const pty = this.tryLoadPty();
		if (pty) {
			try {
				return this.spawnPty(pty, file, args, input, transport, cols, rows);
			} catch (error) {
				// A present-but-broken prebuild (e.g. the JS lib installed
				// without its native binary) must DEGRADE, not fail the
				// session — the pipe floor is the whole point.
				this.context?.logger?.warn?.(
					`pty-local: PTY spawn unavailable (${
						error instanceof Error ? error.message : String(error)
					}) — falling back to pipe floor.`
				);
			}
		}
		return this.spawnPipeFloor(file, args, input, transport);
	}

	async probe(_settings?: PluginSettings): Promise<{ ok: boolean; detail?: string }> {
		const pty = this.tryLoadPty();
		return pty
			? { ok: true, detail: 'node-pty prebuild present (full PTY).' }
			: {
					ok: true,
					detail: 'node-pty prebuild unavailable — pipe floor active (no resize).'
				};
	}

	// ── PTY path ────────────────────────────────────────────────────

	private spawnPty(
		pty: PtyModuleLike,
		file: string,
		args: string[],
		input: TerminalSpawnInput,
		transport: TerminalTransport,
		cols: number,
		rows: number
	): TerminalSessionHandle {
		let proc: PtyProcessLike;
		try {
			proc = pty.spawn(file, args, {
				cwd: input.cwd,
				env: { ...input.env },
				cols,
				rows,
				name: 'xterm-256color'
			});
		} catch (error) {
			throw new TerminalNotProvisionedError(
				`PTY spawn failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}

		let seq = 0;
		proc.onData((data) => {
			transport.publish({
				kind: 'stdout',
				seq: seq++,
				data: Buffer.from(data, 'utf8').toString('base64')
			});
		});

		const exited = new Promise<{ code: number; reason: 'completed' | 'crashed' | 'closed' }>((resolve) => {
			proc.onExit(({ exitCode }) => {
				const reason = killed ? 'closed' : exitCode === 0 ? 'completed' : 'crashed';
				// Exit frame BEFORE resolution — the ordering contract.
				transport.publish({ kind: 'exit', code: exitCode, reason });
				void transport.close().finally(() => resolve({ code: exitCode, reason }));
			});
		});

		let killed = false;
		void this.consumeInbound(transport, {
			write: (bytes) => proc.write(bytes.toString('latin1')),
			resize: (c, r) => proc.resize(c, r),
			endOnInputClose: input.endOnInputClose === true,
			kill: () => {
				killed = true;
				proc.kill();
			}
		});

		return {
			runId: input.runId,
			isPty: true,
			write: (data) => proc.write(Buffer.from(data).toString('latin1')),
			resize: (c, r) => proc.resize(c, r),
			kill: (signal) => {
				killed = true;
				proc.kill(signal);
			},
			exited
		};
	}

	// ── Pipe floor ──────────────────────────────────────────────────

	private spawnPipeFloor(
		file: string,
		args: string[],
		input: TerminalSpawnInput,
		transport: TerminalTransport
	): TerminalSessionHandle {
		let child: ChildProcess;
		try {
			child = spawnChild(file, args, {
				cwd: input.cwd,
				env: { ...input.env },
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true
			});
		} catch (error) {
			throw new TerminalNotProvisionedError(
				`Process spawn failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		if (!child.pid) {
			// Spawn errors on some platforms surface via the 'error' event
			// instead of throwing; treat both as not-provisioned once the
			// process never came up. The error listener below still runs
			// for the async case.
		}

		let seq = 0;
		const pump = (chunk: Buffer) => {
			transport.publish({
				kind: 'stdout',
				seq: seq++,
				data: chunk.toString('base64')
			});
		};
		child.stdout?.on('data', pump);
		// PTY merges streams; the floor emulates that so the pane shows
		// stderr too instead of a mysteriously silent failure.
		child.stderr?.on('data', pump);

		let killed = false;
		const exited = new Promise<{ code: number; reason: 'completed' | 'crashed' | 'closed' }>((resolve) => {
			const finish = (code: number | null) => {
				const exitCode = code ?? -1;
				const reason = killed ? 'closed' : exitCode === 0 ? 'completed' : 'crashed';
				transport.publish({ kind: 'exit', code: exitCode, reason });
				void transport.close().finally(() => resolve({ code: exitCode, reason }));
			};
			child.once('exit', (code) => finish(code));
			child.once('error', () => finish(-1));
		});

		void this.consumeInbound(transport, {
			write: (bytes) => child.stdin?.write(bytes),
			resize: () => {
				// Pipe floor: no resize. The UI's isPty:false banner covers it.
			},
			endOnInputClose: input.endOnInputClose === true,
			kill: () => {
				killed = true;
				child.kill();
			}
		});

		return {
			runId: input.runId,
			isPty: false,
			write: (data) => void child.stdin?.write(Buffer.from(data)),
			resize: () => undefined,
			kill: (signal) => {
				killed = true;
				child.kill(signal as NodeJS.Signals | undefined);
			},
			exited
		};
	}

	// ── shared inbound pump ─────────────────────────────────────────

	private async consumeInbound(
		transport: TerminalTransport,
		io: {
			write: (bytes: Buffer) => void;
			resize: (cols: number, rows: number) => void;
			endOnInputClose: boolean;
			kill: () => void;
		}
	): Promise<void> {
		try {
			for await (const frame of transport.inbound()) {
				if (frame.kind === 'stdin') {
					io.write(Buffer.from(frame.data, 'base64'));
				} else if (frame.kind === 'resize') {
					io.resize(frame.cols, frame.rows);
				}
				// Every other kind is upstream's problem — the relay's
				// direction guards already refused them; drop defensively.
			}
		} catch (error) {
			this.context?.logger?.warn?.(
				`pty-local inbound pump ended with error: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		if (io.endOnInputClose) {
			io.kill();
		}
	}

	// ── runtime require ─────────────────────────────────────────────

	private tryLoadPty(): PtyModuleLike | null {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const required = require('@homebridge/node-pty-prebuilt-multiarch') as PtyModuleLike;
			return typeof required?.spawn === 'function' ? required : null;
		} catch {
			return null;
		}
	}

	// ── IPlugin lifecycle ───────────────────────────────────────────

	async onLoad(context: PluginContext): Promise<void> {
		this.context = context;
		const pty = this.tryLoadPty();
		context.logger.log(`pty-local terminal host loaded; mode=${pty ? 'pty' : 'pipe-floor (no node-pty prebuild)'}`);
	}

	async onUnload(): Promise<void> {
		this.context = undefined;
	}

	async healthCheck(): Promise<PluginHealthCheck> {
		const probe = await this.probe();
		return { status: 'healthy', message: probe.detail ?? 'ok', checkedAt: Date.now() };
	}

	getManifest(): PluginManifest {
		return {
			id: this.id,
			name: this.name,
			version: this.version,
			description:
				'Hosts live agent terminal sessions in the executing worker: real PTY when available, honest pipe floor otherwise.',
			category: this.category,
			capabilities: [...this.capabilities],
			builtIn: true,
			defaultForCapabilities: ['terminal-stream'],
			icon: { type: 'lucide', value: 'Terminal', backgroundColor: '#0f172a' }
		};
	}
}
