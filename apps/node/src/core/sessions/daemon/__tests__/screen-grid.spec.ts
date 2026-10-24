import { describe, expect, it } from 'vitest';
import { FLEET_SESSION_REPLAY_LINES, FLEET_SESSION_SCROLLBACK_LINES } from '@ever-works/contracts';
import { Terminal } from '@xterm/headless';
import { ScreenGrid, stripTerminalResponses } from '../screen-grid';

/**
 * The daemon's headless screen (spec FR-4, FR-5, ACC-FL04-02, ACC-FL04-03).
 */

const lines = (count: number, from = 0) =>
	Array.from({ length: count }, (_, index) => `line ${from + index}`).join('\r\n') + '\r\n';

/** Render escape sequences in a fresh terminal and read its text back. */
async function render(sequences: string, cols = 80, rows = 24): Promise<string[]> {
	const terminal = new Terminal({ cols, rows, scrollback: 10_000, allowProposedApi: true });
	await new Promise<void>((resolve) => terminal.write(sequences, resolve));
	const out: string[] = [];
	const buffer = terminal.buffer.active;
	for (let index = 0; index < buffer.length; index += 1)
		out.push(buffer.getLine(index)?.translateToString(true) ?? '');
	terminal.dispose();
	return out;
}

describe('ScreenGrid', () => {
	it('keeps 10 000 lines of scrollback and no more', async () => {
		const grid = new ScreenGrid(80, 24);
		grid.write(lines(12_000));
		await grid.flush();
		expect(grid.lineCount).toBe(FLEET_SESSION_SCROLLBACK_LINES + 24);
		const text = await grid.plainText(FLEET_SESSION_SCROLLBACK_LINES + 24);
		expect(text.startsWith('line 1977')).toBe(true);
		expect(text.endsWith('line 11999')).toBe(true);
		grid.dispose();
	});

	it('replays the screen plus the last 2 000 lines, and a fresh terminal shows the same thing (FR-4)', async () => {
		const grid = new ScreenGrid(80, 24);
		grid.write(lines(5_000));
		grid.write('\x1b[31mred tail\x1b[0m');
		const replay = await grid.replay();
		const rendered = (await render(replay)).filter((line) => line.length > 0);
		// At most 2 000 lines of history plus the visible rows.
		expect(rendered.length).toBeLessThanOrEqual(FLEET_SESSION_REPLAY_LINES + 24);
		expect(rendered.length).toBeGreaterThanOrEqual(FLEET_SESSION_REPLAY_LINES);
		expect(rendered[rendered.length - 1]).toBe('red tail');
		expect(rendered[rendered.length - 2]).toBe('line 4999');
		// Colour survives the replay (regenerated, not stripped).
		expect(replay).toContain('\x1b[31m');
		grid.dispose();
	});

	it('takes the replay exactly at the call: output written after it is not in it', async () => {
		const grid = new ScreenGrid(80, 24);
		grid.write('before\r\n');
		const replay = grid.replay();
		grid.write('after\r\n');
		const text = (await render(await replay)).join('\n');
		expect(text).toContain('before');
		expect(text).not.toContain('after');
		grid.dispose();
	});

	it('answers a cursor-position query itself (FR-5)', async () => {
		const grid = new ScreenGrid(80, 24);
		const answers: string[] = [];
		grid.onResponse((data) => answers.push(data));
		grid.write('abc\x1b[6n');
		await grid.flush();
		expect(answers).toEqual(['\x1b[1;4R']);
		grid.dispose();
	});

	it('gives plain text with no escapes, trailing blank lines dropped, wrapped lines joined', async () => {
		const grid = new ScreenGrid(10, 5);
		grid.write('\x1b[1;32mgreen\x1b[0m\r\n0123456789abcdef\r\n\r\n');
		const text = await grid.plainText(10);
		expect(text).toBe('green\n0123456789abcdef');
		// eslint-disable-next-line no-control-regex
		expect(text).not.toMatch(/\x1b/);
		grid.dispose();
	});

	it('counts the last lines from the text, not from the bottom of an empty screen', async () => {
		const grid = new ScreenGrid(80, 24);
		grid.write('first\r\nsecond\r\nthird');
		expect(await grid.plainText(2)).toBe('second\nthird');
		expect(await grid.plainText(1)).toBe('third');
		grid.dispose();
	});

	it('resizes', async () => {
		const grid = new ScreenGrid(80, 24);
		grid.resize(120, 40);
		expect([grid.cols, grid.rows]).toEqual([120, 40]);
		grid.dispose();
	});
});

describe('stripTerminalResponses', () => {
	it('removes answers to terminal queries and keeps everything a person types', () => {
		expect(stripTerminalResponses('ls\r')).toBe('ls\r');
		expect(stripTerminalResponses('\x1b[12;40R')).toBe('');
		expect(stripTerminalResponses('a\x1b[?1;2cb')).toBe('ab');
		expect(stripTerminalResponses('\x1b[>0;276;0c')).toBe('');
		expect(stripTerminalResponses('\x1b]11;rgb:0000/0000/0000\x07x')).toBe('x');
		expect(stripTerminalResponses('\x1b]10;rgb:ffff/ffff/ffff\x1b\\')).toBe('');
		// Arrow keys and other input sequences are not answers.
		expect(stripTerminalResponses('\x1b[A\x1b[B')).toBe('\x1b[A\x1b[B');
	});
});
