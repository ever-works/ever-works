import { SerializeAddon } from '@xterm/addon-serialize';
import { Terminal, type ITerminalAddon } from '@xterm/headless';
import { FLEET_SESSION_REPLAY_LINES, FLEET_SESSION_SCROLLBACK_LINES } from '@ever-works/contracts';

/**
 * Sessions on computers (FL-04) — the daemon's headless picture of one
 * session's terminal (spec FR-4, FR-5).
 *
 * The daemon feeds every byte the process prints through a headless
 * terminal emulator — the same emulator family the web pane renders with —
 * so it always knows what the screen looks like, with
 * {@link FLEET_SESSION_SCROLLBACK_LINES} lines of scrollback behind it. Three
 * things follow from that:
 *
 *  - **replay** — a viewer that attaches late gets the current screen plus
 *    the last {@link FLEET_SESSION_REPLAY_LINES} lines REGENERATED as escape
 *    sequences (colours, cursor and all), never a blank pane and never a raw
 *    history that would replay every clear and redraw;
 *  - **plain text** — the last lines without escapes, for the ended
 *    session's kept screen, `fleet_sessions_read` and FL-05's rules;
 *  - **answers** — a program that asks the terminal a question (cursor
 *    position, device attributes, colours) while nobody is watching gets
 *    the emulator's answer, so it never hangs waiting (spec FR-5). The
 *    daemon forwards those answers only while no driver is attached: a
 *    driver's own terminal answers for itself.
 */
export class ScreenGrid {
	private readonly terminal: Terminal;
	private readonly serializer = new SerializeAddon();
	private readonly responseListeners = new Set<(data: string) => void>();
	private disposed = false;

	constructor(cols: number, rows: number, scrollback: number = FLEET_SESSION_SCROLLBACK_LINES) {
		this.terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
		// The serialize addon is typed against the browser terminal; it uses only
		// the buffer API the headless terminal shares, so it loads into this one.
		this.terminal.loadAddon(this.serializer as unknown as ITerminalAddon);
		this.terminal.onData((data) => {
			for (const listener of [...this.responseListeners]) {
				try {
					listener(data);
				} catch {
					// a listener's failure is its own
				}
			}
		});
	}

	get cols(): number {
		return this.terminal.cols;
	}

	get rows(): number {
		return this.terminal.rows;
	}

	/** Lines held: the screen plus the scrollback in use. */
	get lineCount(): number {
		return this.terminal.buffer.active.length;
	}

	/** Feed output the process printed. */
	write(data: string | Uint8Array): void {
		if (this.disposed) return;
		this.terminal.write(data);
	}

	/**
	 * Run `read` at the exact point where every byte written BEFORE this call
	 * has been parsed and none written after it has. The marker is queued
	 * synchronously and `read` runs inside the emulator's own callback for
	 * it, so a caller that starts buffering live output in the same tick it
	 * calls this gets a snapshot and a live stream that neither overlap nor
	 * leave a gap (the attach replay depends on it).
	 */
	private at<T>(read: () => T, fallback: T): Promise<T> {
		if (this.disposed) return Promise.resolve(fallback);
		return new Promise((resolve) => {
			this.terminal.write('', () => {
				try {
					resolve(this.disposed ? fallback : read());
				} catch {
					resolve(fallback);
				}
			});
		});
	}

	/** Resolve once every byte written so far has been parsed. */
	flush(): Promise<void> {
		return this.at(() => undefined, undefined);
	}

	resize(cols: number, rows: number): void {
		if (this.disposed || (cols === this.terminal.cols && rows === this.terminal.rows)) return;
		this.terminal.resize(cols, rows);
	}

	/** Listen for the emulator's answers to terminal queries. */
	onResponse(listener: (data: string) => void): () => void {
		this.responseListeners.add(listener);
		return () => {
			this.responseListeners.delete(listener);
		};
	}

	/**
	 * The current screen and the last `lines` of scrollback as escape
	 * sequences a fresh terminal can be fed to look the same — exactly as of
	 * this call (see {@link at}).
	 */
	replay(lines: number = FLEET_SESSION_REPLAY_LINES): Promise<string> {
		return this.at(() => this.serializer.serialize({ scrollback: Math.max(0, lines) }), '');
	}

	/**
	 * The last `lines` lines (screen included) as plain text: no escapes,
	 * trailing spaces trimmed, trailing blank lines dropped.
	 */
	plainText(lines: number = FLEET_SESSION_REPLAY_LINES): Promise<string> {
		return this.at(() => this.readPlain(lines), '');
	}

	private readPlain(lines: number): string {
		const buffer = this.terminal.buffer.active;
		// The text ends at the cursor or the last line with anything on it,
		// whichever is lower — never at the bottom of an empty viewport.
		let end = buffer.baseY + buffer.cursorY;
		for (let index = buffer.length - 1; index > end; index -= 1) {
			if ((buffer.getLine(index)?.translateToString(true) ?? '').length > 0) {
				end = index;
				break;
			}
		}
		const out: string[] = [];
		const start = Math.max(0, end + 1 - Math.max(1, lines));
		for (let index = start; index <= end && index < buffer.length; index += 1) {
			const line = buffer.getLine(index);
			if (!line) continue;
			const text = line.translateToString(true);
			// A wrapped line continues the previous one: join, so a long line reads as one.
			if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
			else out.push(text);
		}
		while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
		return out.join('\n');
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.responseListeners.clear();
		this.terminal.dispose();
	}
}

/**
 * Answers a terminal sends back to a program, by shape: cursor position
 * reports (`CSI row ; col R`), device attributes (`CSI ? … c`, `CSI > … c`),
 * device status (`CSI 0 n`), and colour reports (`OSC 10/11/12/4 ; … ST|BEL`).
 * Several drivers each answering the same question would hand the program
 * duplicate answers, so the daemon drops these from every driver but the
 * newest (plan §15 "double terminal-query answers").
 */
const RESPONSE_SHAPED =
	// eslint-disable-next-line no-control-regex
	/\x1b\[\d{1,4};\d{1,4}R|\x1b\[[?>][\d;]*c|\x1b\[0n|\x1b\](?:1[0-2]|4;\d{1,3});[^\x07\x1b]{0,64}(?:\x07|\x1b\\)/g;

export function stripTerminalResponses(input: string): string {
	return input.replace(RESPONSE_SHAPED, '');
}
