import type { FleetDesktopTiles } from '@ever-works/contracts';

/**
 * Desktop view & control (FL-07, plan §3 "Web rendering", T-24) — paints a
 * Desktop-source stream on a `<canvas>`: a keyframe resets the canvas to its
 * size and draws it whole; each `TILES` payload draws its 64-pixel tiles at
 * their offsets, in arrival order. Tiles for a picture of another size than the
 * last keyframe are ignored and a fresh keyframe asked for; three tiles in a
 * row that do not decode ask for one too.
 *
 * Every picture is decoded off the main thread (`createImageBitmap`) and drawn
 * through ONE promise chain, so a slow decode never paints a newer picture
 * under an older one.
 */

export interface DesktopPainterHost {
    canvas(): HTMLCanvasElement | null;
    /** Ask the machine for a full picture. */
    requestKeyframe(): void;
    /** A picture was painted (the stall timer's heartbeat). */
    painted?(size: { width: number; height: number }): void;
}

/** Undecodable tiles in a row before a keyframe is asked for. */
export const DESKTOP_MAX_BAD_TILES = 3;

type Decoder = (blob: Blob) => Promise<ImageBitmap>;

export class DesktopPainter {
    private chain: Promise<void> = Promise.resolve();
    private size: { width: number; height: number } | null = null;
    private badTiles = 0;
    private disposed = false;

    constructor(
        private readonly host: DesktopPainterHost,
        private readonly decode: Decoder = (blob) => createImageBitmap(blob),
    ) {}

    /** The size of the last keyframe (the picture the tiles belong to). */
    get pictureSize(): { width: number; height: number } | null {
        return this.size;
    }

    keyframe(picture: { blob: Blob; width: number; height: number }): Promise<void> {
        return this.enqueue(async () => {
            const bitmap = await this.decode(picture.blob);
            const canvas = this.host.canvas();
            if (!canvas || this.disposed) {
                bitmap.close?.();
                return;
            }
            if (canvas.width !== picture.width) canvas.width = picture.width;
            if (canvas.height !== picture.height) canvas.height = picture.height;
            canvas.getContext('2d')?.drawImage(bitmap, 0, 0, picture.width, picture.height);
            bitmap.close?.();
            this.size = { width: picture.width, height: picture.height };
            this.badTiles = 0;
            this.host.painted?.(this.size);
        });
    }

    tiles(tiles: FleetDesktopTiles): Promise<void> {
        return this.enqueue(async () => {
            const size = this.size;
            if (!size || size.width !== tiles.width || size.height !== tiles.height) {
                // Tiles of a picture this canvas does not show: resynchronise.
                this.host.requestKeyframe();
                return;
            }
            const canvas = this.host.canvas();
            const context = canvas?.getContext('2d');
            if (!canvas || !context || this.disposed) return;
            for (const tile of tiles.tiles) {
                try {
                    const bitmap = await this.decode(
                        new Blob([new Uint8Array(tile.data)], { type: 'image/jpeg' }),
                    );
                    context.drawImage(bitmap, tile.x, tile.y, tile.w, tile.h);
                    bitmap.close?.();
                    this.badTiles = 0;
                } catch {
                    this.badTiles += 1;
                    if (this.badTiles >= DESKTOP_MAX_BAD_TILES) {
                        this.badTiles = 0;
                        this.host.requestKeyframe();
                    }
                }
            }
            this.host.painted?.(size);
        });
    }

    dispose(): void {
        this.disposed = true;
    }

    private enqueue(step: () => Promise<void>): Promise<void> {
        this.chain = this.chain.then(step).catch(() => {
            // a picture that cannot be drawn is skipped; the next keyframe repaints
        });
        return this.chain;
    }
}
