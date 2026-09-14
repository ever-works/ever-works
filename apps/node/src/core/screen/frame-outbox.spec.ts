import { describe, expect, it, vi } from 'vitest';
import {
	COMPUTER_MAX_BATCH_BYTES,
	COMPUTER_MAX_BATCH_FRAMES,
	COMPUTER_MAX_FRAME_BYTES,
	decodedComputerBase64Bytes,
	type ComputerNodeToServerFrame,
	type ComputerScreenFrame
} from '@ever-works/contracts';
import type { ComputerPublishAnswer } from '../job-client';
import { COMPUTER_OUTBOX_MAX_PENDING_PICTURES, ComputerFrameOutbox, scrubOutboundComputerFrame } from './frame-outbox';

const SESSION = '33333333-2222-4333-8444-555555555555';
// A string the shared scanner recognises as a credential (a GitHub token shape).
const TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;

function picture(seq: number, bytes = 1024): ComputerScreenFrame {
	return {
		kind: 'frame',
		seq,
		keyframe: true,
		width: 800,
		height: 600,
		mime: 'image/jpeg',
		data: Buffer.alloc(bytes, seq % 250).toString('base64')
	};
}

const accepted: ComputerPublishAnswer = { accepted: 1, dropped: 0, ended: false, closeReason: null };

describe('scrubOutboundComputerFrame — nothing leaves unscanned', () => {
	it('redacts a credential in terminal output before it leaves the machine', () => {
		const frame = scrubOutboundComputerFrame({
			kind: 'terminal',
			frame: { kind: 'stdout', seq: 0, data: Buffer.from(`export TOKEN=${TOKEN}\n`).toString('base64') }
		});
		const text =
			frame.kind === 'terminal' && frame.frame.kind === 'stdout'
				? Buffer.from(frame.frame.data, 'base64').toString()
				: '';
		expect(text).not.toContain(TOKEN);
	});

	it('passes terminal bytes through untouched when nothing was found', () => {
		const data = Buffer.from([0xff, 0xfe, 0x00, 0x41]).toString('base64');
		const frame = scrubOutboundComputerFrame({ kind: 'terminal', frame: { kind: 'stdout', seq: 1, data } });
		expect(frame).toEqual({ kind: 'terminal', frame: { kind: 'stdout', seq: 1, data } });
	});

	it('redacts a credential in a banner, and leaves a picture alone', () => {
		const banner = scrubOutboundComputerFrame({ kind: 'error', message: `failed with ${TOKEN}` });
		expect(banner.kind === 'error' && banner.message).not.toContain(TOKEN);
		const shot = picture(1);
		expect(scrubOutboundComputerFrame(shot)).toBe(shot);
	});
});

describe('ComputerFrameOutbox', () => {
	it('never publishes a batch over 8 pictures or 512 KiB of picture data', async () => {
		const batches: ComputerNodeToServerFrame[][] = [];
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const publisher = {
			publishComputerFrames: vi.fn(async (_id: string, frames: readonly ComputerNodeToServerFrame[]) => {
				batches.push([...frames]);
				if (batches.length === 1) await gate;
				return accepted;
			})
		};
		const outbox = new ComputerFrameOutbox({ sessionId: SESSION, publisher });
		outbox.push(picture(1));
		// While the first publish is in flight, queue more than one batch can carry.
		for (let seq = 2; seq <= COMPUTER_OUTBOX_MAX_PENDING_PICTURES + 1; seq += 1)
			outbox.push(picture(seq, 200 * 1024));
		release();
		await outbox.flush();

		for (const batch of batches) {
			const pictures = batch.filter((frame): frame is ComputerScreenFrame => frame.kind === 'frame');
			expect(pictures.length).toBeLessThanOrEqual(COMPUTER_MAX_BATCH_FRAMES);
			expect(
				pictures.reduce((sum, frame) => sum + decodedComputerBase64Bytes(frame.data), 0)
			).toBeLessThanOrEqual(COMPUTER_MAX_BATCH_BYTES);
		}
		expect(batches.length).toBeGreaterThan(2);
	});

	it('drops the OLDEST waiting pictures when the link cannot keep up, and counts them', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const sent: number[] = [];
		const publisher = {
			publishComputerFrames: vi.fn(async (_id: string, frames: readonly ComputerNodeToServerFrame[]) => {
				for (const frame of frames) if (frame.kind === 'frame') sent.push(frame.seq);
				if (sent.length === 1) await gate;
				return accepted;
			})
		};
		const outbox = new ComputerFrameOutbox({ sessionId: SESSION, publisher });
		outbox.push(picture(1));
		for (let seq = 2; seq <= COMPUTER_OUTBOX_MAX_PENDING_PICTURES + 4; seq += 1) outbox.push(picture(seq));
		expect(outbox.backlog()).toBe(COMPUTER_OUTBOX_MAX_PENDING_PICTURES);
		expect(outbox.dropped()).toBe(3);
		release();
		await outbox.flush();
		expect(sent).not.toContain(2);
		expect(sent.at(-1)).toBe(COMPUTER_OUTBOX_MAX_PENDING_PICTURES + 4);
	});

	it('refuses a picture larger than one frame may be', () => {
		const outbox = new ComputerFrameOutbox({
			sessionId: SESSION,
			publisher: { publishComputerFrames: vi.fn(async () => accepted) }
		});
		expect(outbox.push(picture(1, COMPUTER_MAX_FRAME_BYTES + 1))).toBe(false);
	});

	it('hands the platform’s end to onEnded once and stops accepting frames', async () => {
		const onEnded = vi.fn();
		const outbox = new ComputerFrameOutbox({
			sessionId: SESSION,
			publisher: {
				publishComputerFrames: vi.fn(async () => ({
					accepted: 1,
					dropped: 0,
					ended: true,
					closeReason: 'closed-by-user' as const
				}))
			},
			onEnded
		});
		outbox.push(picture(1));
		await outbox.flush();
		expect(onEnded).toHaveBeenCalledTimes(1);
		expect(onEnded).toHaveBeenCalledWith('closed-by-user');
		expect(outbox.isEnded).toBe(true);
		expect(outbox.push(picture(2))).toBe(false);
	});

	it('treats a refused credential as the end of the view, and survives a transient failure', async () => {
		const onEnded = vi.fn();
		const failures = [
			Object.assign(new Error('network down'), { kind: 'network' }),
			Object.assign(new Error('refused'), { kind: 'unauthorized' })
		];
		const outbox = new ComputerFrameOutbox({
			sessionId: SESSION,
			publisher: {
				publishComputerFrames: vi.fn(async () => {
					throw failures.shift();
				})
			},
			onEnded
		});
		outbox.push(picture(1));
		outbox.push({ kind: 'error', message: 'second' });
		await outbox.flush();
		expect(onEnded).toHaveBeenCalledWith(null);
	});

	it('measures bytes the platform accepted and the publish round trip', async () => {
		let now = 1000;
		const outbox = new ComputerFrameOutbox({
			sessionId: SESSION,
			now: () => now,
			publisher: {
				publishComputerFrames: vi.fn(async () => {
					now += 250;
					return accepted;
				})
			}
		});
		outbox.push(picture(1, 2048));
		await outbox.flush();
		expect(outbox.bytesOut()).toBe(2048);
		expect(outbox.lastAckMs()).toBe(250);
	});
});
