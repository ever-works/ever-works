import { createHash } from 'node:crypto';
import { encodeDesktopTiles } from '@ever-works/contracts';
import { HELPER_MESSAGES, HelperMessageDecoder, encodeHelperJson, encodeHelperMessage } from './helper-protocol';
import type { HelperChild, HelperSpawner } from './helper-process';
import type { HelperFs } from './helper-trust';

/**
 * Desktop view & control (FL-07) — test doubles for the screen helper: an
 * in-memory {@link HelperFs} and a fake helper process that speaks the helper
 * protocol with synthetic pictures (no binary, no display). Used by the node
 * specs only.
 */

export function memoryHelperFs(files: Record<string, string | Uint8Array> = {}): HelperFs & {
	files: Map<string, Uint8Array>;
} {
	const store = new Map<string, Uint8Array>();
	for (const [path, content] of Object.entries(files)) {
		store.set(path, typeof content === 'string' ? new TextEncoder().encode(content) : content);
	}
	return {
		files: store,
		async readText(path) {
			const bytes = store.get(path);
			return bytes ? new TextDecoder().decode(bytes) : null;
		},
		async writePrivate(path, content) {
			store.set(path, new TextEncoder().encode(content));
		},
		async writeExecutable(path, bytes) {
			store.set(path, bytes);
		},
		async remove(path) {
			store.delete(path);
		},
		async isFile(path) {
			return store.has(path);
		},
		async sha256(path) {
			const bytes = store.get(path);
			if (!bytes) throw new Error('ENOENT');
			return createHash('sha256').update(bytes).digest('hex');
		}
	};
}

export function sha256Of(content: string | Uint8Array): string {
	return createHash('sha256')
		.update(typeof content === 'string' ? new TextEncoder().encode(content) : content)
		.digest('hex');
}

/** A tiny "JPEG" the codecs accept (SOI … EOI). */
export function fakeJpeg(fill = 7, length = 32): Uint8Array {
	const bytes = new Uint8Array(length).fill(fill);
	bytes[0] = 0xff;
	bytes[1] = 0xd8;
	bytes[length - 2] = 0xff;
	bytes[length - 1] = 0xd9;
	return bytes;
}

export interface FakeHelperOptions {
	reasons?: string[];
	displays?: Array<Record<string, unknown>>;
	/** Answer `start` with this error code instead of starting. */
	startError?: string;
	/** Never send hello. */
	silent?: boolean;
}

type Listener = (...args: never[]) => void;

/** A fake helper child: hello on spawn, `started` + a keyframe on start, tiles on refresh. */
export class FakeHelperChild implements HelperChild {
	readonly received: Array<{ kind: number; payload: Uint8Array }> = [];
	private readonly listeners = new Map<string, Listener[]>();
	private readonly decoder = new HelperMessageDecoder();
	private alive = true;
	readonly stdin = {
		write: (chunk: Uint8Array): boolean => {
			for (const message of this.decoder.push(chunk)) this.onCommand(message.kind, message.payload);
			return true;
		},
		end: (): void => this.exit(0)
	};
	readonly stdout = { on: (_event: 'data', listener: (chunk: Uint8Array) => void) => this.add('stdout', listener) };
	readonly stderr = { on: (_event: 'data', listener: (chunk: Uint8Array) => void) => this.add('stderr', listener) };

	constructor(
		readonly path: string,
		readonly env: Record<string, string>,
		private readonly options: FakeHelperOptions = {}
	) {
		if (!options.silent) {
			queueMicrotask(() =>
				this.emitMessage(
					encodeHelperJson(HELPER_MESSAGES.hello, {
						protocol: 1,
						version: '0.1.0',
						platform: 'linux',
						reasons: options.reasons ?? [],
						displays: this.displays()
					})
				)
			);
		}
	}

	on(event: 'exit' | 'error', listener: Listener): this {
		this.add(event, listener);
		return this;
	}

	kill(): boolean {
		this.exit(null);
		return true;
	}

	/** The helper dies on its own (a crash). */
	crash(): void {
		this.exit(1);
	}

	emitMessage(bytes: Uint8Array): void {
		if (!this.alive) return;
		for (const listener of this.listeners.get('stdout') ?? []) (listener as (chunk: Uint8Array) => void)(bytes);
	}

	sendFrame(): void {
		const jpeg = fakeJpeg();
		const payload = new Uint8Array(4 + jpeg.byteLength);
		new DataView(payload.buffer).setUint16(0, 64);
		new DataView(payload.buffer).setUint16(2, 64);
		payload.set(jpeg, 4);
		this.emitMessage(encodeHelperMessage(HELPER_MESSAGES.frame, payload));
	}

	sendTiles(): void {
		const tiles = encodeDesktopTiles({ width: 64, height: 64, tiles: [{ x: 0, y: 0, w: 64, h: 64, data: fakeJpeg(3) }] });
		if (tiles) this.emitMessage(encodeHelperMessage(HELPER_MESSAGES.tiles, tiles));
	}

	private displays(): Array<Record<string, unknown>> {
		return this.options.displays ?? [{ id: 'DP-1', name: 'Display 1', width: 1920, height: 1080, scale: 1, primary: true }];
	}

	private onCommand(kind: number, payload: Uint8Array): void {
		this.received.push({ kind, payload });
		if (kind === HELPER_MESSAGES.start) {
			if (this.options.startError) {
				this.emitMessage(encodeHelperJson(HELPER_MESSAGES.error, { code: this.options.startError, message: 'no' }));
				return;
			}
			const displays = this.displays();
			this.emitMessage(
				encodeHelperJson(HELPER_MESSAGES.started, { display: displays[0], displays, fellBack: false })
			);
			this.sendFrame();
		} else if (kind === HELPER_MESSAGES.refresh) {
			this.sendFrame();
		} else if (kind === HELPER_MESSAGES.listDisplays) {
			this.emitMessage(encodeHelperJson(HELPER_MESSAGES.displays, { displays: this.displays() }));
		} else if (kind === HELPER_MESSAGES.setDisplay) {
			const displays = this.displays();
			const wanted = JSON.parse(new TextDecoder().decode(payload)).display;
			const display = displays.find((entry) => entry.id === wanted);
			if (!display) {
				this.emitMessage(encodeHelperJson(HELPER_MESSAGES.error, { code: 'unknown-display', message: 'gone' }));
				return;
			}
			this.emitMessage(encodeHelperJson(HELPER_MESSAGES.started, { display, displays, fellBack: false }));
		}
	}

	private add(event: string, listener: Listener): void {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
	}

	private exit(code: number | null): void {
		if (!this.alive) return;
		this.alive = false;
		queueMicrotask(() => {
			for (const listener of this.listeners.get('exit') ?? []) (listener as (code: number | null, signal: null) => void)(code, null);
		});
	}
}

/** A spawner that hands out {@link FakeHelperChild}ren and remembers them. */
export function fakeHelperSpawner(options: FakeHelperOptions = {}): { spawner: HelperSpawner; children: FakeHelperChild[] } {
	const children: FakeHelperChild[] = [];
	return {
		children,
		spawner: (path, env) => {
			const child = new FakeHelperChild(path, env, options);
			children.push(child);
			return child;
		}
	};
}
