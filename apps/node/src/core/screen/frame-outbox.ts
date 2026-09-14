import {
	COMPUTER_MAX_BATCH_BYTES,
	COMPUTER_MAX_BATCH_FRAMES,
	COMPUTER_MAX_FRAME_BYTES,
	decodedComputerBase64Bytes,
	redactSecrets,
	type ComputerCloseReason,
	type ComputerNodeToServerFrame,
	type TerminalFrame
} from '@ever-works/contracts';
import type { ComputerPublishAnswer } from '../job-client';
import type { Logger } from '../logger';

/**
 * Agent computers — everything a live view sends off this machine goes
 * through ONE outbox.
 *
 * Two jobs, both of which must hold for every frame no matter which channel
 * produced it:
 *
 *  1. **Nothing leaves unscanned.** Every string a frame carries — terminal
 *     output, a banner — is run through the platform's own secret scanner
 *     (`redactSecrets` from `@ever-works/contracts`, the SAME definition the
 *     server applies) before it is queued. A picture carries no text.
 *     Terminal output is rewritten only when the scanner found something, so
 *     bytes that are not text pass through untouched.
 *  2. **Nothing exceeds the protocol.** Publishes are single-flight and cut
 *     at {@link COMPUTER_MAX_BATCH_FRAMES} pictures /
 *     {@link COMPUTER_MAX_BATCH_BYTES} of picture data, so the platform never
 *     has to refuse a batch. A picture over {@link COMPUTER_MAX_FRAME_BYTES}
 *     is refused here. When the link is slower than the capture, the OLDEST
 *     waiting pictures are dropped first — a live view wants the newest
 *     picture, not a backlog — and the backlog count is what the capture
 *     pump degrades on.
 *
 * The platform's answer closes the loop: `ended` (the owner closed the view,
 * the stop switch, the reaper) is handed to `onEnded` exactly once.
 */

/** Most frames of any kind one publish carries (well inside the platform's own per-publish cap). */
export const COMPUTER_OUTBOX_MAX_ITEMS = COMPUTER_MAX_BATCH_FRAMES * 2;
/** Most pictures kept waiting while a publish is in flight; older ones are dropped. */
export const COMPUTER_OUTBOX_MAX_PENDING_PICTURES = COMPUTER_MAX_BATCH_FRAMES;

export interface ComputerFramePublisher {
	publishComputerFrames(
		sessionId: string,
		frames: readonly ComputerNodeToServerFrame[],
		signal?: AbortSignal
	): Promise<ComputerPublishAnswer>;
}

export interface ComputerFrameOutboxOptions {
	sessionId: string;
	publisher: ComputerFramePublisher;
	onEnded?: (reason: ComputerCloseReason | null) => void;
	logger?: Logger;
	now?: () => number;
}

/** Scan every string a frame carries; returns the frame to send (possibly rewritten). */
export function scrubOutboundComputerFrame(frame: ComputerNodeToServerFrame): ComputerNodeToServerFrame {
	switch (frame.kind) {
		case 'error':
			return { kind: 'error', message: redactSecrets(frame.message).cleaned };
		case 'terminal':
			return { kind: 'terminal', frame: scrubTerminalFrame(frame.frame) };
		default:
			return frame;
	}
}

function scrubTerminalFrame(frame: TerminalFrame): TerminalFrame {
	if (frame.kind === 'stdout') {
		const text = Buffer.from(frame.data, 'base64').toString('utf8');
		const { cleaned, redactions } = redactSecrets(text);
		return redactions > 0 ? { ...frame, data: Buffer.from(cleaned, 'utf8').toString('base64') } : frame;
	}
	if (frame.kind === 'error') {
		return { ...frame, message: redactSecrets(frame.message).cleaned };
	}
	return frame;
}

export class ComputerFrameOutbox {
	private readonly queue: ComputerNodeToServerFrame[] = [];
	private readonly now: () => number;
	private flushing: Promise<void> | null = null;
	private closed = false;
	private ended = false;
	private sentBytes = 0;
	private ackMs = 0;
	private droppedPictures = 0;

	constructor(private readonly options: ComputerFrameOutboxOptions) {
		this.now = options.now ?? (() => Date.now());
	}

	/** Queue one frame (scrubbed first) and start a publish if none is running. False when refused. */
	push(frame: ComputerNodeToServerFrame): boolean {
		if (this.closed || this.ended) return false;
		if (frame.kind === 'frame' && decodedComputerBase64Bytes(frame.data) > COMPUTER_MAX_FRAME_BYTES) {
			return false;
		}
		this.queue.push(scrubOutboundComputerFrame(frame));
		this.trimPictures();
		void this.flush();
		return true;
	}

	/** Pictures waiting to be published. */
	backlog(): number {
		return this.queue.reduce((count, frame) => count + (frame.kind === 'frame' ? 1 : 0), 0);
	}

	/** Round trip of the last publish, in milliseconds. */
	lastAckMs(): number {
		return this.ackMs;
	}

	/** Picture bytes the platform accepted since the view opened. */
	bytesOut(): number {
		return this.sentBytes;
	}

	/** Pictures dropped because the link could not keep up. */
	dropped(): number {
		return this.droppedPictures;
	}

	get isEnded(): boolean {
		return this.ended;
	}

	/** Publish until the queue is empty (single-flight). */
	flush(): Promise<void> {
		if (this.flushing) return this.flushing;
		const run = this.drain().finally(() => {
			if (this.flushing === run) this.flushing = null;
		});
		this.flushing = run;
		return run;
	}

	/**
	 * Stop accepting frames. With `final`, that frame (the `end` frame) is
	 * queued last and everything is flushed within `budgetMs`.
	 */
	async close(final?: ComputerNodeToServerFrame, budgetMs = 5000): Promise<void> {
		if (final && !this.ended) {
			this.queue.push(scrubOutboundComputerFrame(final));
		}
		this.closed = true;
		if (this.ended) return;
		await Promise.race([this.flush(), new Promise<void>((resolve) => setTimeout(resolve, budgetMs).unref?.())]);
	}

	private trimPictures(): void {
		let pictures = this.backlog();
		if (pictures <= COMPUTER_OUTBOX_MAX_PENDING_PICTURES) return;
		for (let i = 0; i < this.queue.length && pictures > COMPUTER_OUTBOX_MAX_PENDING_PICTURES; ) {
			if (this.queue[i].kind === 'frame') {
				this.queue.splice(i, 1);
				pictures -= 1;
				this.droppedPictures += 1;
			} else {
				i += 1;
			}
		}
	}

	private async drain(): Promise<void> {
		while (this.queue.length > 0 && !this.ended) {
			const batch = this.takeBatch();
			const started = this.now();
			try {
				const answer = await this.options.publisher.publishComputerFrames(this.options.sessionId, batch);
				this.ackMs = Math.max(0, this.now() - started);
				for (const frame of batch) {
					if (frame.kind === 'frame') this.sentBytes += decodedComputerBase64Bytes(frame.data);
				}
				if (answer.ended) {
					this.markEnded(answer.closeReason);
					return;
				}
			} catch (error) {
				this.ackMs = Math.max(0, this.now() - started);
				const detail = error instanceof Error ? error.message : String(error);
				this.options.logger?.warn(`Live view ${this.options.sessionId}: publish failed: ${detail}`);
				if ((error as { kind?: string })?.kind === 'unauthorized') {
					// The platform no longer recognises this view for this machine.
					this.markEnded(null);
					return;
				}
				// A transient failure loses this batch (a live view wants the next
				// picture, not a retry of an old one) and backs off briefly.
				await new Promise<void>((resolve) => setTimeout(resolve, 500).unref?.());
			}
		}
	}

	private takeBatch(): ComputerNodeToServerFrame[] {
		const batch: ComputerNodeToServerFrame[] = [];
		let pictures = 0;
		let bytes = 0;
		while (this.queue.length > 0 && batch.length < COMPUTER_OUTBOX_MAX_ITEMS) {
			const next = this.queue[0];
			if (next.kind === 'frame') {
				const size = decodedComputerBase64Bytes(next.data);
				if (
					pictures > 0 &&
					(pictures + 1 > COMPUTER_MAX_BATCH_FRAMES || bytes + size > COMPUTER_MAX_BATCH_BYTES)
				) {
					break;
				}
				pictures += 1;
				bytes += size;
			}
			batch.push(this.queue.shift() as ComputerNodeToServerFrame);
		}
		return batch;
	}

	private markEnded(reason: ComputerCloseReason | null): void {
		if (this.ended) return;
		this.ended = true;
		this.queue.length = 0;
		try {
			this.options.onEnded?.(reason);
		} catch {
			// the listener's failure is its own
		}
	}
}
