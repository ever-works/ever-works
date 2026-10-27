import { describe, expect, it } from 'vitest';
import { encodeComputerFrame, encodeDesktopRecordingChunk, encodeDesktopTiles } from '@ever-works/contracts';
import {
    DesktopRecordingPlayback,
    eventsToShow,
    formatRecordingTime,
    recordingEventsOf,
} from './desktop-recording-playback';

/** Desktop view & control (FL-07 P2.C, T-41) — replaying a recording: seeks paint the keyframe before, then its tiles. */

const text = new TextEncoder();
const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]);

function frame(width = 64): Uint8Array {
    return text.encode(
        encodeComputerFrame({
            kind: 'frame',
            seq: 0,
            keyframe: true,
            width,
            height: 64,
            mime: 'image/jpeg',
            data: btoa(String.fromCharCode(...jpeg)),
        })!,
    );
}

function tiles(): Uint8Array {
    return encodeDesktopTiles({ width: 64, height: 64, tiles: [{ x: 0, y: 0, w: 64, h: 64, data: jpeg }] })!;
}

function chunk(entries: Array<[number, 20 | 23]>): Uint8Array {
    return encodeDesktopRecordingChunk(
        entries.map(([tMs, kind]) => ({ tMs, kind, payload: kind === 20 ? frame() : tiles() })),
    )!;
}

function canvas() {
    const painted: string[] = [];
    return {
        painted,
        keyframe: async () => {
            painted.push('frame');
        },
        tiles: async () => {
            painted.push('tiles');
        },
    };
}

describe('recording events', () => {
    it('decodes keyframes and tiles, skipping what does not read', () => {
        const events = recordingEventsOf(chunk([[0, 20], [500, 23]]));
        expect(events.map((event) => [event.tMs, event.kind])).toEqual([
            [0, 'frame'],
            [500, 'tiles'],
        ]);
        expect(recordingEventsOf(new Uint8Array([1, 2, 3]))).toEqual([]);
    });

    it('shows a time from the keyframe at or before it', () => {
        const events = recordingEventsOf(chunk([[0, 20], [400, 23], [1_000, 20], [1_200, 23], [1_600, 23]]));
        expect(eventsToShow(events, 1_300).map((event) => event.tMs)).toEqual([1_000, 1_200]);
        expect(eventsToShow(events, 999).map((event) => event.tMs)).toEqual([0, 400]);
        expect(eventsToShow(events, -1)).toEqual([]);
    });

    it('formats a position', () => {
        expect(formatRecordingTime(65_000)).toBe('1:05');
        expect(formatRecordingTime(3_725_000)).toBe('1:02:05');
    });
});

describe('DesktopRecordingPlayback', () => {
    it('fetches chunks only as far as playback needs, then plays forward', async () => {
        const fetched: number[] = [];
        const chunks = [chunk([[0, 20], [30_000, 23]]), chunk([[60_000, 20], [61_000, 23]])];
        const target = canvas();
        const playback = new DesktopRecordingPlayback(
            [
                { seq: 0, startMs: 0, endMs: 30_000, bytes: 1 },
                { seq: 1, startMs: 60_000, endMs: 61_000, bytes: 1 },
            ],
            async (seq) => {
                fetched.push(seq);
                return chunks[seq];
            },
            target,
        );
        await playback.seek(10_000);
        expect(fetched).toEqual([0]);
        expect(target.painted).toEqual(['frame']);
        await playback.advance(61_500);
        expect(fetched).toEqual([0, 1]);
        expect(target.painted).toEqual(['frame', 'tiles', 'frame', 'tiles']);
        expect(playback.timeMs).toBe(61_500);
    });

    it('seeks back by repainting from the keyframe before', async () => {
        const target = canvas();
        const playback = new DesktopRecordingPlayback(
            [{ seq: 0, startMs: 0, endMs: 2_000, bytes: 1 }],
            async () => chunk([[0, 20], [500, 23], [2_000, 20]]),
            target,
        );
        await playback.seek(2_000);
        target.painted.length = 0;
        await playback.seek(600);
        expect(target.painted).toEqual(['frame', 'tiles']);
    });
});
