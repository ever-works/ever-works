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
 *
 * That pause fails CLOSED: while control is held, nothing is injected until
 * telling the Agent to pause has succeeded for this stretch of control. A
 * failure is reported through `onPauseFailed` (once per stretch) and retried
 * at most every {@link INPUT_INJECTOR_PAUSE_RETRY_MS} as input keeps arriving,
 * so the Agent and a person never drive the same browser at once.
 */

/** How often a failed pause is retried while control is held and input keeps arriving. */
export const INPUT_INJECTOR_PAUSE_RETRY_MS = 2000;

export type InputInjectionOutcome =
	| 'injected'
	/** Nobody in this view holds control. */
	| 'not-controlled'
	/** Control is held, but the Agent could not be told to pause yet: nothing is injected until it is. */
	| 'agent-not-paused'
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
	/**
	 * Told every time control is taken (true) or given back (false). Its
	 * failure is logged, never thrown — and while control is held, input is
	 * refused until taking it (true) has succeeded.
	 */
	onControlChange?: (controlled: boolean) => void | Promise<void>;
	/**
	 * The Agent could not be told to pause while control is held, so input is
	 * refused for now. Called once per stretch of control; never thrown into.
	 */
	onPauseFailed?: (error: unknown) => void;
	logger?: Logger;
	/** Clock for the pause retry interval; defaults to `Date.now`. */
	now?: () => number;
}

export class ComputerInputInjector {
	private held = false;
	private tail: Promise<unknown> = Promise.resolve();
	/** Bumped on every change of control: a pause counts only for the stretch it was made in. */
	private stretch = 0;
	/** The stretch of control the Agent was last paused for. */
	private pausedStretch = -1;
	/** The stretch whose failed pause was already reported. */
	private reportedStretch = -1;
	private lastPauseAttemptAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly options: InputInjectorOptions) {}

	get controlled(): boolean {
		return this.held;
	}

	/** The platform's latest word on whether this view holds control. */
	setControlled(controlled: boolean): void {
		if (controlled === this.held) return;
		this.held = controlled;
		this.stretch += 1;
		const stretch = this.stretch;
		const hook = this.options.onControlChange;
		if (!hook) return;
		this.tail = this.tail
			.then(() => (controlled ? this.pause(stretch) : hook(false)))
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
		if (!(await this.agentPaused())) return 'agent-not-paused';
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

	/**
	 * True when the Agent has been told to pause for the current stretch of
	 * control (or there is no Agent to tell). A failed pause is retried here,
	 * in the injection queue, at most every {@link INPUT_INJECTOR_PAUSE_RETRY_MS}.
	 */
	private async agentPaused(): Promise<boolean> {
		if (!this.options.onControlChange) return true;
		if (this.pausedStretch === this.stretch) return true;
		if (this.now() - this.lastPauseAttemptAt < INPUT_INJECTOR_PAUSE_RETRY_MS) return false;
		await this.pause(this.stretch);
		return this.held && this.pausedStretch === this.stretch;
	}

	/** Tell the Agent to pause for `stretch`. Never throws: a failure is reported and leaves input refused. */
	private async pause(stretch: number): Promise<void> {
		const hook = this.options.onControlChange;
		if (!hook) return;
		this.lastPauseAttemptAt = this.now();
		try {
			await hook(true);
			if (stretch === this.stretch) this.pausedStretch = stretch;
		} catch (error) {
			this.options.logger?.warn(
				`Live view: could not tell the Agent to pause, so input is not injected: ${describe(error)}`
			);
			if (stretch === this.stretch && this.reportedStretch !== stretch) {
				this.reportedStretch = stretch;
				try {
					this.options.onPauseFailed?.(error);
				} catch {
					// the listener's failure is its own
				}
			}
		}
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
