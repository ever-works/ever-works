import { COMPUTER_MAX_TEXT_LENGTH } from '@ever-works/contracts';
import type { InputInjectionOutcome } from '../../../screen/input-injector';

/**
 * Paste into a desktop (FL-11 P2, plan §6.1, T-19) — the live views on this
 * machine a paste may land in, by view id (the computer session's id, CONTRACTS
 * R-27).
 *
 * A live view registers itself while it runs (`executors/computer-session.ts`)
 * and is gone the moment it ends, so a paste can only ever reach a view that is
 * open now. The view's own input injector is the last gate, exactly as for a
 * person's typing: text lands only while that view holds control, the Agent is
 * paused first, and it goes into the focused element of the surface (the
 * browser's `Input.insertText`) — no clipboard is written and none is ever
 * read on this machine (FR-32).
 */

export interface PasteTarget {
	/** Insert `text` where the focus is; the injector's outcome for the first chunk that did not land, else `injected`. */
	paste(text: string): Promise<InputInjectionOutcome>;
}

export class PasteTargets {
	private readonly targets = new Map<string, PasteTarget>();

	/** Register a live view; the returned function unregisters it (only if it is still this target). */
	register(viewId: string, target: PasteTarget): () => void {
		this.targets.set(viewId, target);
		return () => {
			if (this.targets.get(viewId) === target) this.targets.delete(viewId);
		};
	}

	get(viewId: string): PasteTarget | null {
		return this.targets.get(viewId) ?? null;
	}

	get size(): number {
		return this.targets.size;
	}
}

/**
 * Split text into pieces of at most {@link COMPUTER_MAX_TEXT_LENGTH} UTF-16
 * units (the live view's `text` input bound), never inside a surrogate pair.
 */
export function chunkPasteText(text: string, max: number = COMPUTER_MAX_TEXT_LENGTH): string[] {
	const out: string[] = [];
	let current = '';
	for (const char of text) {
		if (current.length + char.length > max) {
			out.push(current);
			current = '';
		}
		current += char;
	}
	if (current.length > 0) out.push(current);
	return out;
}

/** A paste target over a view's input injector: the text as `text` inputs, in order. */
export function injectorPasteTarget(
	inject: (frame: { kind: 'text'; text: string }) => Promise<InputInjectionOutcome>
): PasteTarget {
	return {
		paste: async (text) => {
			for (const chunk of chunkPasteText(text)) {
				const outcome = await inject({ kind: 'text', text: chunk });
				if (outcome !== 'injected') return outcome;
			}
			return 'injected';
		}
	};
}
