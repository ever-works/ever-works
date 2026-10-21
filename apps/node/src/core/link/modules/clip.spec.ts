import { describe, expect, it } from 'vitest';
import { FLEET_CLIP_MAX_BYTES, FLEET_LINK_FRAME_KINDS, type FleetConsents } from '@ever-works/contracts';
import { chunkPasteText, createClipLinkModule, injectorPasteTarget, PasteTargets } from './clip';
import type { NodeChannelContext, NodeChannelHandler, NodeLinkControlState } from './registry';

/**
 * Paste into a desktop (FL-11 P2, T-19) — the `clip` family: opens only on a
 * view that is open here, takes one `CLIP` within 256 KiB, hands it to the
 * view's injector (which pastes only while the view holds control), answers
 * `clip.pasted` with the byte count or `clip.failed` with the reason. The paste
 * target has no read method: nothing is ever read back. Written, not run.
 */

const ATTEND: FleetConsents = { work: false, attend: true, manage: false, usageScan: false };

function harness(viewId: string, paused = false) {
	const json: Array<Record<string, unknown>> = [];
	const control: NodeLinkControlState = { paused, drain: null, onChange: () => () => undefined };
	const context: NodeChannelContext = {
		channel: 4,
		family: 'clip',
		params: { viewId },
		consents: ATTEND,
		control,
		nodeVersion: '1.0.0',
		nodeName: 'design-mac',
		sendJson: (message) => {
			json.push(message);
			return true;
		},
		sendBinary: () => true,
		sendControl: () => true,
		close: () => undefined,
		operations: { start: () => 'op', progress: () => undefined, done: () => undefined }
	};
	return { context, json };
}

async function settle(): Promise<void> {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('chunkPasteText', () => {
	it('splits at the bound without breaking a surrogate pair', () => {
		expect(chunkPasteText('abcdef', 4)).toEqual(['abcd', 'ef']);
		const emoji = '😀'.repeat(3); // 6 UTF-16 units
		expect(chunkPasteText(emoji, 3)).toEqual(['😀', '😀', '😀']);
		expect(chunkPasteText('', 4)).toEqual([]);
	});
});

describe('clip module', () => {
	it('refuses a view that is not open here', async () => {
		const module = createClipLinkModule({ targets: new PasteTargets(), nodeName: 'design-mac' });
		const { context } = harness('view-1');
		expect(await module.families![0].open(context)).toMatchObject({
			ok: false,
			error: { code: 'unsupported_on_node' }
		});
	});

	it('pastes into the open view through its injector and answers the bytes', async () => {
		const targets = new PasteTargets();
		const typed: string[] = [];
		targets.register(
			'view-1',
			injectorPasteTarget(async (frame) => {
				typed.push(frame.text);
				return 'injected';
			})
		);
		const module = createClipLinkModule({ targets, nodeName: 'design-mac' });
		const { context, json } = harness('view-1');
		const result = await module.families![0].open(context);
		const handler = (result as { handler: NodeChannelHandler }).handler;
		const text = 'export DATABASE_URL=postgres://x';
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.CLIP, new TextEncoder().encode(text));
		await settle();
		expect(typed.join('')).toBe(text);
		expect(json).toEqual([{ type: 'clip.pasted', bytes: text.length }]);
	});

	it('says "Take control first" when the view does not hold control (U11)', async () => {
		const targets = new PasteTargets();
		targets.register(
			'view-1',
			injectorPasteTarget(async () => 'not-controlled')
		);
		const module = createClipLinkModule({ targets, nodeName: 'design-mac' });
		const { context, json } = harness('view-1');
		const handler = ((await module.families![0].open(context)) as { handler: NodeChannelHandler }).handler;
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.CLIP, new TextEncoder().encode('x'));
		await settle();
		expect(json[0]).toMatchObject({
			type: 'clip.failed',
			error: { code: 'permission_denied', hint: 'Take control first' }
		});
	});

	it('refuses more than 256 KiB before anything is pasted (U8)', async () => {
		const targets = new PasteTargets();
		let called = false;
		targets.register(
			'view-1',
			injectorPasteTarget(async () => {
				called = true;
				return 'injected';
			})
		);
		const module = createClipLinkModule({ targets, nodeName: 'design-mac' });
		const { context, json } = harness('view-1');
		const handler = ((await module.families![0].open(context)) as { handler: NodeChannelHandler }).handler;
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.CLIP, new Uint8Array(FLEET_CLIP_MAX_BYTES + 1).fill(65));
		await settle();
		expect(called).toBe(false);
		expect(json[0]).toMatchObject({ type: 'clip.failed', error: { code: 'limit_exceeded' } });
	});

	it('takes one paste per channel and nothing while the fleet is stopped', async () => {
		const targets = new PasteTargets();
		const typed: string[] = [];
		targets.register(
			'view-1',
			injectorPasteTarget(async (frame) => {
				typed.push(frame.text);
				return 'injected';
			})
		);
		const module = createClipLinkModule({ targets, nodeName: 'design-mac' });
		const { context } = harness('view-1');
		const handler = ((await module.families![0].open(context)) as { handler: NodeChannelHandler }).handler;
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.CLIP, new TextEncoder().encode('one'));
		handler.onBinary!(FLEET_LINK_FRAME_KINDS.CLIP, new TextEncoder().encode('two'));
		await settle();
		expect(typed).toEqual(['one']);
		const stopped = harness('view-1', true);
		expect(await module.families![0].open(stopped.context)).toMatchObject({
			ok: false,
			error: { code: 'kill_switch' }
		});
	});

	it('forgets a view once it ends', () => {
		const targets = new PasteTargets();
		const unregister = targets.register(
			'view-1',
			injectorPasteTarget(async () => 'injected')
		);
		expect(targets.get('view-1')).not.toBeNull();
		unregister();
		expect(targets.get('view-1')).toBeNull();
	});
});
