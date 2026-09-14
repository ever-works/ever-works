import {
	isComputerInputFrame,
	isComputerShortcutBlocked,
	normalizeComputerFrame,
	type ComputerInputFrame
} from '@ever-works/contracts';
import type { Logger } from '../logger';
import type { CaptureSource } from './capture-backend';

/**
 * Agent computers — the input injector: a person's pointer, wheel, keys and
 * text into the Agent's own browser, while (and only while) they hold control.
 *
 * The platform decides who holds control; this machine hears it from its own
 * live-view leg as a `mode` frame, and this module is the last gate before a
 * page sees an event. It injects ONLY when all of these hold:
 *
 *   - this view holds control (`controlling` was the last word from the
 *     platform) — before it, and after it is given back, nothing is injected;
 *   - the frame is one of the four input kinds, rebuilt field by field by the
 *     shared codec — anything else (a clipboard payload, a file drop, a frame
 *     kind this build does not know) is refused, never guessed at;
 *   - a key press is not a blocked shortcut (clipboard, window and tab
 *     combinations, the operating system keys — the list the owner's surface
 *     shows) — refused here even if a browser sent one.
 *
 * Injections are serialized so a press and its release reach the page in the
 * order the person made them. Nothing here throws: every refusal and failure
 * is an outcome.
 *
 * Pausing the Agent: while control is held the Agent must not drive the same
 * browser, and must be told why rather than left to fail. On every change of
 * control this module calls `onControlChange`, which the executor turns into
 * a marker in the Agent's own profile directory (see `agent-control-marker.ts`)
 * — the file the Agent's own tooling on this machine is told to respect.
 */

export type InputInjectionOutcome =
	| 'injected'
	/** Nobody in this view holds control. */
	| 'not-controlled'
	/** Not an input frame (or not a valid one). */
	| 'refused-kind'
	/** A blocked shortcut. */
	| 'refused-shortcut'
	/** The surface cannot be driven (no capture, or a backend without input). */
	| 'no-target'
	/** The surface refused it. */
	| 'failed';

export interface InputInjectorOptions {
	/** The surface being shown now (the capture pump's source may be restarted). */
	target: () => Pick<CaptureSource, 'dispatchInput'> | null;
	/** Told every time control is taken (true) or given back (false). Its failure is logged, never thrown. */
	onControlChange?: (controlled: boolean) => void | Promise<void>;
	logger?: Logger;
}

export class ComputerInputInjector {
	private held = false;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: InputInjectorOptions) {}

	get controlled(): boolean {
		return this.held;
	}

	/** The platform's latest word on whether this view holds control. */
	setControlled(controlled: boolean): void {
		if (controlled === this.held) return;
		this.held = controlled;
		const hook = this.options.onControlChange;
		if (!hook) return;
		this.tail = this.tail
			.then(() => hook(controlled))
			.catch((error: unknown) =>
				this.options.logger?.warn(`Live view: could not record the change of control: ${describe(error)}`)
			);
	}

	/**
	 * Inject one frame as it arrived off the wire. Whether control is held is
	 * read when the frame ARRIVES, not when its turn in the queue comes, so
	 * input sent before control was taken (or after it was given back) is
	 * never injected just because a change of control overtook it. Never throws.
	 */
	inject(raw: unknown): Promise<InputInjectionOutcome> {
		const heldOnArrival = this.held;
		const run = this.tail.then(() => this.injectNow(raw, heldOnArrival));
		this.tail = run.catch(() => undefined);
		return run.catch(() => 'failed' as const);
	}

	/** Wait for every queued injection and control change to settle. */
	async idle(): Promise<void> {
		await this.tail.catch(() => undefined);
	}

	private async injectNow(raw: unknown, heldOnArrival: boolean): Promise<InputInjectionOutcome> {
		let frame: ComputerInputFrame | null = null;
		try {
			const normalized = normalizeComputerFrame(raw);
			frame = normalized && isComputerInputFrame(normalized) ? normalized : null;
		} catch {
			frame = null;
		}
		if (!frame) return 'refused-kind';
		if (!heldOnArrival || !this.held) return 'not-controlled';
		if (frame.kind === 'key' && isComputerShortcutBlocked(frame)) return 'refused-shortcut';
		let target: Pick<CaptureSource, 'dispatchInput'> | null = null;
		try {
			target = this.options.target();
		} catch {
			target = null;
		}
		if (!target?.dispatchInput) return 'no-target';
		try {
			await target.dispatchInput(frame);
			return 'injected';
		} catch (error) {
			// Never the frame itself: typed text is a person's keystrokes.
			this.options.logger?.warn(`Live view: the browser refused a ${frame.kind} input: ${describe(error)}`);
			return 'failed';
		}
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
