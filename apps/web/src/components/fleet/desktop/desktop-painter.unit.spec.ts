import { describe, expect, it, vi } from 'vitest';
import { DesktopPainter, DESKTOP_MAX_BAD_TILES } from './desktop-painter';

/**
 * Desktop view & control (FL-07, T-24) — a keyframe resets the canvas to its
 * size; tiles are drawn at their offsets in order; tiles of another size, or
 * three that do not decode, ask for a keyframe.
 */

function harness(decode?: (blob: Blob) => Promise<ImageBitmap>) {
    const drawn: Array<[number, number, number, number]> = [];
    const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
            drawImage: (_image: unknown, x: number, y: number, w: number, h: number) =>
                drawn.push([x, y, w, h]),
        }),
    } as unknown as HTMLCanvasElement;
    const requestKeyframe = vi.fn();
    const painted = vi.fn();
    const painter = new DesktopPainter(
        { canvas: () => canvas, requestKeyframe, painted },
        decode ?? (async () => ({ close: () => undefined }) as unknown as ImageBitmap),
    );
    return { painter, canvas, drawn, requestKeyframe, painted };
}

const tile = (x: number, y: number) => ({
    x,
    y,
    w: 64,
    h: 64,
    data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
});

describe('DesktopPainter', () => {
    it('resizes the canvas on a keyframe and paints it whole', async () => {
        const { painter, canvas, drawn, painted } = harness();
        await painter.keyframe({ blob: new Blob([]), width: 1280, height: 800 });
        expect([canvas.width, canvas.height]).toEqual([1280, 800]);
        expect(drawn).toEqual([[0, 0, 1280, 800]]);
        expect(painted).toHaveBeenCalledWith({ width: 1280, height: 800 });
    });

    it('draws tiles at their offsets, in order', async () => {
        const { painter, drawn } = harness();
        await painter.keyframe({ blob: new Blob([]), width: 128, height: 128 });
        await painter.tiles({ width: 128, height: 128, tiles: [tile(64, 0), tile(0, 64)] });
        expect(drawn.slice(1)).toEqual([
            [64, 0, 64, 64],
            [0, 64, 64, 64],
        ]);
    });

    it('asks for a keyframe for tiles of a picture it does not show', async () => {
        const { painter, drawn, requestKeyframe } = harness();
        await painter.tiles({ width: 128, height: 128, tiles: [tile(0, 0)] });
        expect(requestKeyframe).toHaveBeenCalledTimes(1);
        await painter.keyframe({ blob: new Blob([]), width: 64, height: 64 });
        await painter.tiles({ width: 128, height: 128, tiles: [tile(0, 0)] });
        expect(requestKeyframe).toHaveBeenCalledTimes(2);
        expect(drawn).toHaveLength(1);
    });

    it(`asks for a keyframe after ${DESKTOP_MAX_BAD_TILES} undecodable tiles`, async () => {
        let calls = 0;
        const { painter, requestKeyframe } = harness(async () => {
            calls += 1;
            if (calls === 1) return { close: () => undefined } as unknown as ImageBitmap;
            throw new Error('bad jpeg');
        });
        await painter.keyframe({ blob: new Blob([]), width: 192, height: 64 });
        await painter.tiles({
            width: 192,
            height: 64,
            tiles: [tile(0, 0), tile(64, 0), tile(128, 0)],
        });
        expect(requestKeyframe).toHaveBeenCalledTimes(1);
    });
});
