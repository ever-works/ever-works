import {
    FLEET_FILES_LIMITS,
    FLEET_FILES_MAX_BYTES_RECORD,
    encodeFleetFilesHeaderRecord,
    fleetFileBaseName,
    isFleetFileName,
    joinFleetFilePath,
    normalizeFleetFileRelativePath,
    type FleetFileEntryView,
    type FleetFileRootView,
    type FleetFilesOperationView,
    type FleetFilesWritePolicy,
    type FleetNodeView,
} from '@ever-works/contracts';
import type { SessionErrorRead } from '../sessions/sessions.shared';

/**
 * Files on computers (FL-11, T-11) — the pure half of the Files tab: the
 * state card the computer calls for, sorting and formatting, the breadcrumb,
 * the conflict policy, the typed-name rule of delete, the operation notices,
 * and the upload's files stream built as a lazy Blob. No React, no I/O
 * beyond building a Blob — the tab and its specs read the same answers.
 */

export type FilesError = SessionErrorRead;

/** Per viewer, per browser (FR-7, U14). */
export const FILES_HIDDEN_STORAGE_KEY = 'ew:fleet:files:hidden';

export const FILES_CONSENT_COMMAND = 'ever-works-node start --manage';
export const FILES_ROOT_COMMAND = 'ever-works-node start --manage --files-root <dir>';

// ─── The tab's state card (spec §5.7) ───────────────────────────────────────

export type FilesTabCard =
    | { kind: 'offline'; lastSeenAt: string | null }
    | { kind: 'consent-missing'; command: string }
    | { kind: 'no-roots'; command: string }
    | { kind: 'permission-denied'; hint: string | null }
    | { kind: 'kill-switch' }
    | { kind: 'desktop-node' }
    | { kind: 'unreachable'; hint: string | null }
    | { kind: 'error'; code: string; hint: string | null };

/**
 * The one card the tab shows instead of the browser, or null to show it.
 * The computer's own state first (a desktop node cannot manage yet; an
 * offline one says when it was last seen), then what the platform answered,
 * then "no folders" (U3).
 */
export function filesTabCard(
    node: Pick<FleetNodeView, 'kind' | 'status' | 'lastHeartbeatAt'>,
    error: FilesError | null,
    roots: readonly FleetFileRootView[] | null,
): FilesTabCard | null {
    if (node.kind === 'desktop-node') return { kind: 'desktop-node' };
    if (node.status === 'offline')
        return { kind: 'offline', lastSeenAt: node.lastHeartbeatAt ?? null };
    if (error) {
        switch (error.code) {
            case 'consent_missing':
                return { kind: 'consent-missing', command: FILES_CONSENT_COMMAND };
            case 'permission_denied':
                return { kind: 'permission-denied', hint: error.hint };
            case 'kill_switch':
                return { kind: 'kill-switch' };
            case 'unreachable':
            case 'network':
                return { kind: 'unreachable', hint: error.hint };
            default:
                return { kind: 'error', code: error.code, hint: error.hint };
        }
    }
    if (roots && roots.length === 0) return { kind: 'no-roots', command: FILES_ROOT_COMMAND };
    return null;
}

/**
 * Why a computer cannot receive a copy (spec §5.5: listed greyed with the
 * reason), or null when it can: a desktop node, offline, management off, or
 * no folder it shares.
 */
export type CopyDestinationReason = 'desktopNode' | 'offline' | 'unmanaged' | 'noFolders';

export function copyDestinationReason(
    node: Pick<FleetNodeView, 'kind' | 'status'> & { capabilities?: readonly string[] | null },
): CopyDestinationReason | null {
    if (node.kind === 'desktop-node') return 'desktopNode';
    if (node.status === 'offline') return 'offline';
    const tags = node.capabilities ?? [];
    if (!tags.includes('managed')) return 'unmanaged';
    if (!tags.includes('files')) return 'noFolders';
    return null;
}

// ─── Entries ────────────────────────────────────────────────────────────────

/** True when opening the entry shows a folder (a folder, or a link to one that stays inside the root). */
export function opensAsFolder(
    entry: Pick<FleetFileEntryView, 'kind' | 'linkInsideRoot' | 'linkKind'>,
): boolean {
    return (
        entry.kind === 'folder' ||
        (entry.kind === 'link' && entry.linkInsideRoot === true && entry.linkKind === 'folder')
    );
}

/** Folders (and folder links) first, then by name, numbers in order. */
export function sortFileEntries<
    T extends Pick<FleetFileEntryView, 'name' | 'kind' | 'linkInsideRoot' | 'linkKind'>,
>(entries: readonly T[]): T[] {
    return [...entries].sort((a, b) => {
        const folderA = opensAsFolder(a) ? 0 : 1;
        const folderB = opensAsFolder(b) ? 0 : 1;
        if (folderA !== folderB) return folderA - folderB;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
}

/** `312 B`, `4.1 KB`, `18 MB`, `1.2 GB` (powers of 1024, one decimal under 10). */
export function formatFileBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** The breadcrumb under a root: `src/server` → `[src, src/server]`. */
export function breadcrumbSegments(path: string): Array<{ name: string; path: string }> {
    if (!path) return [];
    const out: Array<{ name: string; path: string }> = [];
    let current = '';
    for (const name of path.split('/')) {
        current = joinFleetFilePath(current, name);
        out.push({ name, path: current });
    }
    return out;
}

/** One folder up (`''` at the root). */
export function parentFilePath(path: string): string {
    const cut = path.lastIndexOf('/');
    return cut < 0 ? '' : path.slice(0, cut);
}

/** "Only these roots are visible on build-01: 3 checkouts, the workspace root, /srv/shared." — its parts. */
export function rootsSummary(roots: readonly FleetFileRootView[]): {
    checkouts: number;
    workspace: boolean;
    listed: string[];
} {
    return {
        checkouts: roots.filter((root) => root.kind === 'checkout').length,
        workspace: roots.some((root) => root.kind === 'workspace'),
        listed: roots.filter((root) => root.kind === 'listed').map((root) => root.path),
    };
}

/** The folder name of a root (the last segment of its path, either separator). */
export function rootFolderName(root: Pick<FleetFileRootView, 'path'>): string {
    const segments = root.path.split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments[segments.length - 1] ?? root.path;
}

/**
 * What delete asks the person to type (FR-18, spec §5.3): the entry's name,
 * or for several entries the folder's name (the root's folder at the top).
 */
export function deleteConfirmName(
    names: readonly string[],
    path: string,
    root: Pick<FleetFileRootView, 'path'>,
): string {
    if (names.length === 1) return names[0];
    return fleetFileBaseName(path) || rootFolderName(root);
}

/** The delete button enables only on an exact match (no trimming, no case folding). */
export function deleteConfirmMatches(typed: string, expected: string): boolean {
    return typed.length > 0 && typed === expected;
}

// ─── Conflicts (FR-13) ──────────────────────────────────────────────────────

export type ConflictChoice = 'skip' | 'replace';

/** The default for every conflict is Skip. */
export function defaultConflictChoices(names: readonly string[]): Record<string, ConflictChoice> {
    return Object.fromEntries(names.map((name) => [name, 'skip' as const]));
}

/**
 * The policy the upload sends: `replaceAll` when every conflict is replaced,
 * else the names to replace (Skip for the rest). More than 200 individual
 * names do not fit a request — the dialog then offers Replace all or Skip all.
 */
export function conflictPolicy(
    choices: Record<string, ConflictChoice>,
): FleetFilesWritePolicy | null {
    const names = Object.keys(choices);
    const replace = names.filter((name) => choices[name] === 'replace');
    if (names.length > 0 && replace.length === names.length) return { replaceAll: true };
    if (replace.length > 200) return null;
    return replace.length > 0 ? { replace } : {};
}

// ─── Upload: the files stream as a lazy Blob ────────────────────────────────

export interface UploadPick {
    file: File;
    /** `/`-separated path relative to the destination folder (a folder upload keeps its tree). */
    path: string;
}

export interface UploadStream {
    blob: Blob;
    entries: number;
    bytes: number;
    /** The top-level names the upload writes — what conflicts are asked about. */
    tops: string[];
}

export type UploadRefusal = {
    code: 'limit_exceeded' | 'invalid';
    reason: 'entries' | 'bytes' | 'name';
    name?: string;
};

function recordHeader(tag: number, length: number): Uint8Array {
    const out = new Uint8Array(5);
    const view = new DataView(out.buffer);
    view.setUint8(0, tag);
    view.setUint32(1, length, false);
    return out;
}

/**
 * The upload body (FL-11 contract records), built without reading a byte:
 * folder headers (parents first), then each file's header and its bytes as
 * `file.slice` parts of at most one record each. The browser streams the Blob
 * from disk; nothing is held in memory but the small headers.
 */
export function buildUploadStream(picks: readonly UploadPick[]): UploadStream | UploadRefusal {
    const files: Array<{ file: File; path: string }> = [];
    const folders = new Set<string>();
    for (const pick of picks) {
        const path = normalizeFleetFileRelativePath(pick.path);
        if (!path) return { code: 'invalid', reason: 'name', name: pick.path };
        const segments = path.split('/');
        if (!segments.every(isFleetFileName))
            return { code: 'invalid', reason: 'name', name: pick.path };
        for (let i = 1; i < segments.length; i += 1) folders.add(segments.slice(0, i).join('/'));
        files.push({ file: pick.file, path });
    }
    const entries = files.length + folders.size;
    if (entries > FLEET_FILES_LIMITS.maxEntries)
        return { code: 'limit_exceeded', reason: 'entries' };
    const bytes = files.reduce((sum, item) => sum + item.file.size, 0);
    if (bytes > FLEET_FILES_LIMITS.maxOpBytes) return { code: 'limit_exceeded', reason: 'bytes' };
    const parts: BlobPart[] = [];
    const tops: string[] = [];
    const top = (path: string) => {
        const name = path.split('/')[0];
        if (!tops.includes(name)) tops.push(name);
    };
    for (const folder of [...folders].sort(
        (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
    )) {
        const header = encodeFleetFilesHeaderRecord({
            path: folder,
            kind: 'folder',
            size: 0,
            mode: 0o755,
            mtimeMs: 0,
        });
        if (!header) return { code: 'invalid', reason: 'name', name: folder };
        parts.push(header as BlobPart);
        top(folder);
    }
    for (const { file, path } of files) {
        const header = encodeFleetFilesHeaderRecord({
            path,
            kind: 'file',
            size: file.size,
            mode: 0o644,
            mtimeMs: file.lastModified > 0 ? file.lastModified : 0,
        });
        if (!header) return { code: 'invalid', reason: 'name', name: path };
        parts.push(header as BlobPart);
        top(path);
        for (let offset = 0; offset < file.size; offset += FLEET_FILES_MAX_BYTES_RECORD) {
            const end = Math.min(file.size, offset + FLEET_FILES_MAX_BYTES_RECORD);
            parts.push(recordHeader(0x42, end - offset) as BlobPart, file.slice(offset, end));
        }
    }
    return { blob: new Blob(parts, { type: 'application/octet-stream' }), entries, bytes, tops };
}

export function isUploadRefusal(value: UploadStream | UploadRefusal): value is UploadRefusal {
    return 'reason' in value;
}

// ─── URLs ───────────────────────────────────────────────────────────────────

/** `/api/fleet/nodes/:id/files/<verb>?root&path…` (the BFF). */
export function filesApiPath(
    nodeId: string,
    verb: string,
    query: Record<string, string | readonly string[] | boolean | number | undefined> = {},
): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === false || value === '') continue;
        if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
        else params.set(key, String(value));
    }
    const qs = params.toString();
    return `/api/fleet/nodes/${encodeURIComponent(nodeId)}/files/${verb}${qs ? `?${qs}` : ''}`;
}

// ─── Operations strip (FR-14, spec §5.6) ────────────────────────────────────

export type OperationNotice =
    | { key: 'running'; percent: number | null }
    | { key: 'done'; bytes: number; seconds: number }
    | { key: 'cancelled'; bytes: number; total: number | null; nodeName: string }
    | { key: 'interrupted'; bytes: number; nodeName: string }
    | { key: 'failed'; hint: string };

export function operationNotice(view: FleetFilesOperationView, nodeName: string): OperationNotice {
    switch (view.state) {
        case 'running':
            return {
                key: 'running',
                percent:
                    view.totalBytes && view.totalBytes > 0
                        ? Math.min(100, Math.floor((view.bytes / view.totalBytes) * 100))
                        : null,
            };
        case 'done': {
            const seconds =
                view.endedAt && view.startedAt
                    ? Math.max(
                          0,
                          Math.round(
                              (Date.parse(view.endedAt) - Date.parse(view.startedAt)) / 1000,
                          ),
                      )
                    : 0;
            return { key: 'done', bytes: view.bytes, seconds };
        }
        case 'cancelled':
            return { key: 'cancelled', bytes: view.bytes, total: view.totalBytes, nodeName };
        case 'interrupted':
            return { key: 'interrupted', bytes: view.bytes, nodeName };
        default:
            return { key: 'failed', hint: view.error?.hint ?? '' };
    }
}

/** The selection cap (FR-16): more than 5 000 items cannot be one transfer. */
export function selectionTooLarge(count: number): boolean {
    return count > FLEET_FILES_LIMITS.maxEntries;
}
