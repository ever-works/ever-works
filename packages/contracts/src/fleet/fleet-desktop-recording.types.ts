/**
 * Desktop view & control (FL-07 P2.C, spec §4.5, FR-48 … FR-56, CONTRACTS R-9) —
 * recordings of Desktop views, and their re-watch.
 *
 * A view is recorded while it is in control mode (always, FR-48) — and while
 * it is only watched when the computer's owner opted in for that computer
 * (`fleet_nodes.recordWatchSessions`, default off). The platform records what
 * the view itself received, as it passed through the viewer gateway: the
 * keyframes (at most one a second, FR-50) and the changed tiles between them,
 * in 60-second chunks written through the configured storage plugin. A
 * recording is capped at 200 MB and 4 hours, expires 14 days after the view
 * ends (the computer's `recordingRetentionDays`, clamped 1–90, FR-52), and is
 * deleted by the nightly sweep (object first, row second) or at once by its
 * owner (class `confirm`, audited `node.desktop.recording.delete`).
 *
 * A recording never holds typed text: control input is never recorded, only
 * the pictures every viewer saw. The watermark is drawn by the player over
 * every picture, the same as the live view (lane log: owner question).
 */

/** The largest recording (FR-50); reaching it stops the recording `size-cap`, the view goes on. */
export const FLEET_DESKTOP_RECORDING_MAX_BYTES = 200 * 1024 * 1024;

/** The longest recording (FR-50); reaching it stops the recording `time-cap`. */
export const FLEET_DESKTOP_RECORDING_MAX_MS = 4 * 60 * 60_000;

/** One chunk covers this long. */
export const FLEET_DESKTOP_RECORDING_CHUNK_MS = 60_000;

/** At most one full picture a second is kept (FR-50). */
export const FLEET_DESKTOP_RECORDING_KEYFRAME_EVERY_MS = 1_000;

/** The default retention, and its clamp (AW-11's `recordingRetentionDays`). */
export const FLEET_DESKTOP_RECORDING_RETENTION_DAYS_DEFAULT = 14;
export const FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MIN = 1;
export const FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MAX = 90;

/** The retention a computer's setting gives, clamped; a missing or broken value is the default. */
export function fleetDesktopRecordingRetentionDays(value: unknown): number {
	const days = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : NaN;
	if (!Number.isFinite(days)) return FLEET_DESKTOP_RECORDING_RETENTION_DAYS_DEFAULT;
	return Math.min(
		FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MAX,
		Math.max(FLEET_DESKTOP_RECORDING_RETENTION_DAYS_MIN, days)
	);
}

/** The nightly retention sweep (`computer-recording-gc`, 03:23 UTC — off the hour, clear of its neighbours). */
export const FLEET_DESKTOP_RECORDING_GC_CRON = '23 3 * * *';

/** Why a recording stopped before its view ended, or how it ended. */
export const FLEET_DESKTOP_RECORDING_STOP_REASONS = [
	'view-ended',
	'control-ended',
	'size-cap',
	'time-cap',
	'storage-failed',
	'kill-switch',
	'deleted'
] as const;

export type FleetDesktopRecordingStopReason = (typeof FLEET_DESKTOP_RECORDING_STOP_REASONS)[number];

export function isFleetDesktopRecordingStopReason(value: unknown): value is FleetDesktopRecordingStopReason {
	return typeof value === 'string' && (FLEET_DESKTOP_RECORDING_STOP_REASONS as readonly string[]).includes(value);
}

/** What started a recording. */
export const FLEET_DESKTOP_RECORDING_TRIGGERS = ['control', 'watch-opt-in'] as const;

export type FleetDesktopRecordingTrigger = (typeof FLEET_DESKTOP_RECORDING_TRIGGERS)[number];

// ─── The chunk container ───────────────────────────────────────────────────

/** `EWR1`: the four bytes every chunk starts with. */
export const FLEET_DESKTOP_RECORDING_MAGIC = new Uint8Array([0x45, 0x57, 0x52, 0x31]);

/** The largest chunk a reader accepts (a chunk is far smaller in practice). */
export const FLEET_DESKTOP_RECORDING_MAX_CHUNK_BYTES = 64 * 1024 * 1024;

/** One recorded picture: a keyframe (`FRAME`, 20 — the computer-frame encoding) or changed tiles (`TILES`, 23). */
export interface FleetDesktopRecordingEntry {
	/** Milliseconds since the recording started. */
	tMs: number;
	/** The node-link frame kind it arrived as (20 or 23). */
	kind: 20 | 23;
	payload: Uint8Array;
}

/** `[magic 4][entries: tMs u32 BE · kind u8 · len u32 BE · payload]`. Null when an entry does not fit. */
export function encodeDesktopRecordingChunk(entries: readonly FleetDesktopRecordingEntry[]): Uint8Array | null {
	let total = FLEET_DESKTOP_RECORDING_MAGIC.byteLength;
	for (const entry of entries) {
		if (entry.kind !== 20 && entry.kind !== 23) return null;
		if (!Number.isInteger(entry.tMs) || entry.tMs < 0 || entry.tMs > 0xffffffff) return null;
		total += 9 + entry.payload.byteLength;
	}
	if (total > FLEET_DESKTOP_RECORDING_MAX_CHUNK_BYTES) return null;
	const out = new Uint8Array(total);
	out.set(FLEET_DESKTOP_RECORDING_MAGIC, 0);
	const view = new DataView(out.buffer);
	let offset = FLEET_DESKTOP_RECORDING_MAGIC.byteLength;
	for (const entry of entries) {
		view.setUint32(offset, entry.tMs);
		out[offset + 4] = entry.kind;
		view.setUint32(offset + 5, entry.payload.byteLength);
		out.set(entry.payload, offset + 9);
		offset += 9 + entry.payload.byteLength;
	}
	return out;
}

/** Read a chunk back; null for anything that is not exactly one (never throws). */
export function decodeDesktopRecordingChunk(bytes: Uint8Array): FleetDesktopRecordingEntry[] | null {
	if (bytes.byteLength < 4 || bytes.byteLength > FLEET_DESKTOP_RECORDING_MAX_CHUNK_BYTES) return null;
	for (let index = 0; index < 4; index += 1) {
		if (bytes[index] !== FLEET_DESKTOP_RECORDING_MAGIC[index]) return null;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const entries: FleetDesktopRecordingEntry[] = [];
	let offset = 4;
	let last = 0;
	while (offset < bytes.byteLength) {
		if (bytes.byteLength - offset < 9) return null;
		const tMs = view.getUint32(offset);
		const kind = bytes[offset + 4];
		const length = view.getUint32(offset + 5);
		if ((kind !== 20 && kind !== 23) || tMs < last || bytes.byteLength - offset - 9 < length) return null;
		entries.push({ tMs, kind, payload: bytes.subarray(offset + 9, offset + 9 + length) });
		last = tMs;
		offset += 9 + length;
	}
	return entries;
}

// ─── Views (CONTRACTS §11.2 `/api/fleet/nodes/:id/desktop/recordings*`) ────

/** One chunk as the player sees it (never a storage key). */
export interface FleetDesktopRecordingChunkView {
	seq: number;
	startMs: number;
	endMs: number;
	bytes: number;
}

/** A stretch of control inside a recording (the player marks them, FR-54). */
export interface FleetDesktopRecordingSpanView {
	userId: string;
	startMs: number;
	endMs: number | null;
}

/** `GET …/desktop/recordings` (a list) and `GET …/recordings/:viewId` (with chunks). */
export interface FleetDesktopRecordingView {
	viewId: string;
	nodeId: string;
	nodeName: string;
	source: 'desktop';
	displayId: string | null;
	quality: string;
	openedByUserId: string;
	trigger: FleetDesktopRecordingTrigger;
	startedAt: string;
	endedAt: string | null;
	durationMs: number;
	bytes: number;
	/** When the nightly sweep deletes it. */
	expiresAt: string | null;
	stoppedReason: FleetDesktopRecordingStopReason | null;
	/** Where it is stored (the storage plugin's name), FR-54. */
	storage: string;
	spans: FleetDesktopRecordingSpanView[];
	chunks?: FleetDesktopRecordingChunkView[];
}

/** `DELETE …/recordings/:viewId` body (CONTRACTS §2.2 class `confirm`). */
export interface FleetDesktopRecordingDeleteRequest {
	confirm?: boolean;
}
