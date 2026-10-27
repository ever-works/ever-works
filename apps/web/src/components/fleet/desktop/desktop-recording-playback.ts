import {
    decodeComputerFrame,
    decodeDesktopRecordingChunk,
    decodeDesktopTiles,
    FLEET_LINK_FRAME_KINDS,
    type FleetDesktopRecordingChunkView,
    type FleetDesktopTiles,
} from '@ever-works/contracts';

/**
 * Desktop view & control (FL-07 P2.C, T-41, FR-53, FR-54) — replays a desktop
 * recording on a painter: the `EWR1` chunks are fetched in order as playback
 * needs them, and a seek paints the last keyframe at or before the time and
 * the tiles after it, so the picture is the one viewers saw then. No React.
 */

/** One picture of the timeline. */
export type DesktopRecordingEvent =
    | { tMs: number; kind: 'frame'; picture: { data: string; mime: string; width: number; height: number } }
    | { tMs: number; kind: 'tiles'; tiles: FleetDesktopTiles };

/** Where the pictures go (`DesktopPainter` fits). */
export interface DesktopRecordingCanvas {
    keyframe(picture: { blob: Blob; width: number; height: number }): Promise<void>;
    tiles(tiles: FleetDesktopTiles): Promise<void>;
}

/** Decode one chunk's entries into timeline events (unreadable entries are skipped). */
export function recordingEventsOf(bytes: Uint8Array): DesktopRecordingEvent[] {
    const entries = decodeDesktopRecordingChunk(bytes);
    if (!entries) return [];
    const events: DesktopRecordingEvent[] = [];
    for (const entry of entries) {
        if (entry.kind === FLEET_LINK_FRAME_KINDS.FRAME) {
            const frame = decodeComputerFrame(entry.payload);
            if (frame && frame.kind === 'frame') {
                events.push({
                    tMs: entry.tMs,
                    kind: 'frame',
                    picture: { data: frame.data, mime: frame.mime, width: frame.width, height: frame.height },
                });
            }
        } else if (entry.kind === FLEET_LINK_FRAME_KINDS.TILES) {
            const tiles = decodeDesktopTiles(entry.payload);
            if (tiles) events.push({ tMs: entry.tMs, kind: 'tiles', tiles });
        }
    }
    return events;
}

/** The events to paint to show time `tMs`: from the last keyframe at or before it. */
export function eventsToShow(events: readonly DesktopRecordingEvent[], tMs: number): DesktopRecordingEvent[] {
    let start = -1;
    for (let index = 0; index < events.length && events[index].tMs <= tMs; index += 1) {
        if (events[index].kind === 'frame') start = index;
    }
    if (start < 0) return [];
    const out: DesktopRecordingEvent[] = [];
    for (let index = start; index < events.length && events[index].tMs <= tMs; index += 1) out.push(events[index]);
    return out;
}

/** `1:02:03` / `4:05`. */
export function formatRecordingTime(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, '0');
    return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

function base64Blob(data: string, mime: string): Blob {
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
}

export class DesktopRecordingPlayback {
    private events: DesktopRecordingEvent[] = [];
    private loaded = 0;
    private loading: Promise<void> | null = null;
    /** Index of the next event `advance` paints. */
    private next = 0;
    private position = 0;

    constructor(
        private readonly chunks: readonly FleetDesktopRecordingChunkView[],
        private readonly fetchChunk: (seq: number) => Promise<Uint8Array | null>,
        private readonly canvas: DesktopRecordingCanvas,
    ) {}

    get timeMs(): number {
        return this.position;
    }

    /** Load chunks in order until one covers `tMs` (or every chunk is in). */
    async ensureLoaded(tMs: number): Promise<void> {
        while (this.loaded < this.chunks.length && (this.loaded === 0 || this.chunks[this.loaded - 1].endMs < tMs)) {
            if (!this.loading) {
                const chunk = this.chunks[this.loaded];
                this.loading = this.fetchChunk(chunk.seq)
                    .then((bytes) => {
                        if (bytes) this.events.push(...recordingEventsOf(bytes));
                        this.events.sort((a, b) => a.tMs - b.tMs);
                        this.loaded += 1;
                    })
                    .finally(() => {
                        this.loading = null;
                    });
            }
            await this.loading;
        }
    }

    /** Show the picture at `tMs`. */
    async seek(tMs: number): Promise<void> {
        await this.ensureLoaded(tMs);
        const shown = eventsToShow(this.events, tMs);
        for (const event of shown) await this.paint(event);
        this.position = tMs;
        this.next = this.events.findIndex((event) => event.tMs > tMs);
        if (this.next < 0) this.next = this.events.length;
    }

    /** Play forward to `tMs`, painting what happened since the last position. */
    async advance(tMs: number): Promise<void> {
        await this.ensureLoaded(tMs);
        while (this.next < this.events.length && this.events[this.next].tMs <= tMs) {
            await this.paint(this.events[this.next]);
            this.next += 1;
        }
        this.position = tMs;
    }

    private paint(event: DesktopRecordingEvent): Promise<void> {
        if (event.kind === 'tiles') return this.canvas.tiles(event.tiles);
        return this.canvas.keyframe({
            blob: base64Blob(event.picture.data, event.picture.mime),
            width: event.picture.width,
            height: event.picture.height,
        });
    }
}
