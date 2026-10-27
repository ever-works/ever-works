import { describe, expect, it } from 'vitest';
import {
	HELPER_INPUT_MAX_BYTES,
	HELPER_MESSAGES,
	HelperMessageDecoder,
	encodeHelperInput,
	encodeHelperJson,
	parseHelperHello,
	parseHelperInputResult
} from './helper-protocol';

/** Desktop view & control (FL-07 P2, T-30/T-31) — the control half of the helper wire. */

const json = (value: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(value));

describe('helper input', () => {
	it('frames the contracts input with the picture size the helper maps from (FR-38)', () => {
		const message = encodeHelperInput(
			{ kind: 'pointer', action: 'down', x: 640, y: 360, button: 'left', buttons: 1 },
			{ width: 1280, height: 720 }
		);
		const [decoded] = new HelperMessageDecoder().push(message!);
		expect(decoded.kind).toBe(HELPER_MESSAGES.input);
		expect(JSON.parse(new TextDecoder().decode(decoded.payload))).toEqual({
			kind: 'pointer',
			action: 'down',
			x: 640,
			y: 360,
			button: 'left',
			buttons: 1,
			pictureWidth: 1280,
			pictureHeight: 720
		});
	});

	it('refuses an input too large for the helper to accept', () => {
		expect(
			encodeHelperInput({ kind: 'text', text: 'x'.repeat(HELPER_INPUT_MAX_BYTES) }, { width: 1, height: 1 })
		).toBeNull();
	});

	it('reads the helper’s refusals as codes only', () => {
		expect(parseHelperInputResult(json({ outcome: 'blocked', code: 'anything' }))).toEqual({
			outcome: 'blocked',
			code: 'blocked-shortcut'
		});
		expect(parseHelperInputResult(json({ outcome: 'refused', code: 'permission-accessibility' }))).toEqual({
			outcome: 'refused',
			code: 'permission-accessibility'
		});
		expect(parseHelperInputResult(json({ outcome: 'refused', code: 'the OS said: you typed hunter2' }))).toEqual({
			outcome: 'refused',
			code: 'inject-failed'
		});
		expect(parseHelperInputResult(json({ outcome: 'injected' }))).toBeNull();
	});

	it('reads what would stop input from hello (known reasons only)', () => {
		const hello = encodeHelperJson(HELPER_MESSAGES.hello, {
			protocol: 1,
			reasons: [],
			displays: [],
			inputReasons: ['permission-accessibility', 'rm -rf']
		});
		const [message] = new HelperMessageDecoder().push(hello);
		expect(parseHelperHello(message.payload)?.inputReasons).toEqual(['permission-accessibility']);
		const older = new HelperMessageDecoder().push(encodeHelperJson(HELPER_MESSAGES.hello, { protocol: 1 }))[0];
		expect(parseHelperHello(older.payload)?.inputReasons).toEqual(['input-unavailable']);
	});
});
