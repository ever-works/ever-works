'use client';

import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceSearchHit, WorkspaceSearchKind } from '@ever-works/contracts/api';

/** A record the operator opened from the palette. Commands are never recorded. */
export interface PaletteRecentEntry {
    /** `${kind}:${sourceId}` */
    key: string;
    kind: WorkspaceSearchKind;
    sourceId: string;
    title: string;
    subtitle: string | null;
    statusLabel: string | null;
    destination: string;
    /** Epoch milliseconds. */
    openedAt: number;
}

export const PALETTE_RECENTS_MAX = 12;
export const PALETTE_RECENTS_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** A recent open inside this window boosts server ranking. */
export const PALETTE_RECENT_BOOST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const STORAGE_PREFIX = 'ever-works:command-palette:recents:v1:';

function storageKey(scopeKey: string): string {
    return `${STORAGE_PREFIX}${scopeKey}`;
}

/**
 * An in-app path only. Security: storage is writable by anything running on
 * the origin, so a `//host` or `/\host` value (both resolve off-site) must
 * never be navigated to from a Recent row.
 */
const IN_APP_PATH = /^\/(?![/\\])/;

function isEntry(value: unknown): value is PaletteRecentEntry {
    if (!value || typeof value !== 'object') return false;
    const entry = value as Record<string, unknown>;
    return (
        typeof entry.key === 'string' &&
        typeof entry.kind === 'string' &&
        typeof entry.sourceId === 'string' &&
        typeof entry.title === 'string' &&
        typeof entry.destination === 'string' &&
        IN_APP_PATH.test(entry.destination) &&
        typeof entry.openedAt === 'number'
    );
}

/**
 * Read the Recent list for one workspace scope, newest first, expired and
 * malformed entries dropped. Never throws: private windows and locked-down
 * browsers make storage access throw, and that must not break the palette.
 */
export function readRecents(scopeKey: string, now = Date.now()): PaletteRecentEntry[] {
    try {
        const raw = window.localStorage.getItem(storageKey(scopeKey));
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter(isEntry)
            .filter((entry) => now - entry.openedAt <= PALETTE_RECENTS_MAX_AGE_MS)
            .sort((a, b) => b.openedAt - a.openedAt)
            .slice(0, PALETTE_RECENTS_MAX);
    } catch {
        return [];
    }
}

function writeRecents(scopeKey: string, entries: PaletteRecentEntry[]): void {
    try {
        window.localStorage.setItem(storageKey(scopeKey), JSON.stringify(entries));
    } catch {
        // Storage unavailable or full — Recent simply does not persist.
    }
}

/** Move-to-top insert, capped at {@link PALETTE_RECENTS_MAX}. Pure. */
export function withRecent(
    entries: ReadonlyArray<PaletteRecentEntry>,
    hit: Pick<
        WorkspaceSearchHit,
        'kind' | 'sourceId' | 'title' | 'subtitle' | 'statusLabel' | 'destination'
    >,
    now = Date.now(),
): PaletteRecentEntry[] {
    const key = `${hit.kind}:${hit.sourceId}`;
    const next: PaletteRecentEntry = {
        key,
        kind: hit.kind,
        sourceId: hit.sourceId,
        title: hit.title,
        subtitle: hit.subtitle,
        statusLabel: hit.statusLabel,
        destination: hit.destination,
        openedAt: now,
    };
    return [next, ...entries.filter((entry) => entry.key !== key)].slice(0, PALETTE_RECENTS_MAX);
}

/** Per-browser, per-workspace-scope Recent list for the command palette. */
export function usePaletteRecents(scopeKey: string) {
    const [recents, setRecents] = useState<PaletteRecentEntry[]>([]);

    useEffect(() => {
        setRecents(readRecents(scopeKey));
    }, [scopeKey]);

    const record = useCallback(
        (hit: Parameters<typeof withRecent>[1]) => {
            const next = withRecent(readRecents(scopeKey), hit);
            writeRecents(scopeKey, next);
            setRecents(next);
        },
        [scopeKey],
    );

    const remove = useCallback(
        (key: string) => {
            const next = readRecents(scopeKey).filter((entry) => entry.key !== key);
            writeRecents(scopeKey, next);
            setRecents(next);
        },
        [scopeKey],
    );

    const refresh = useCallback(() => setRecents(readRecents(scopeKey)), [scopeKey]);

    return { recents, record, remove, refresh };
}
