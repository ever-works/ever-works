'use client';

import { useEffect, useState } from 'react';

/**
 * Lane aw-ops — small pure helpers and one hook the live Deploy tab shares.
 *
 * `useClientNow` answers `null` during the server render and the first client render, then the
 * current time every `everyMs`: anything relative ("checked 2 minutes ago", "OOM in the last
 * 24 hours") is computed only after mount, so the server and the browser never render different
 * text (no hydration mismatch from two clocks).
 */
export function useClientNow(everyMs = 30_000): number | null {
    const [now, setNow] = useState<number | null>(null);
    useEffect(() => {
        setNow(Date.now());
        const id = setInterval(() => setNow(Date.now()), everyMs);
        return () => clearInterval(id);
    }, [everyMs]);
    return now;
}

/** Whole minutes between an ISO instant and `now`; `null` when either is unknown. */
export function minutesSince(iso: string | null | undefined, now: number | null): number | null {
    if (!iso || now === null) return null;
    const at = new Date(iso).getTime();
    if (Number.isNaN(at)) return null;
    return Math.max(0, Math.floor((now - at) / 60_000));
}

/** Whether an ISO instant lies within the last `hours` of `now`. */
export function withinHours(iso: string | null | undefined, now: number | null, hours: number): boolean {
    if (!iso || now === null) return false;
    const at = new Date(iso).getTime();
    return !Number.isNaN(at) && now - at >= 0 && now - at <= hours * 3_600_000;
}

/** A run's duration in whole seconds, when both ends are known. */
export function durationSeconds(start?: string | null, end?: string | null): number | null {
    if (!start || !end) return null;
    const a = new Date(start).getTime();
    const b = new Date(end).getTime();
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
    return Math.round((b - a) / 1000);
}

/** The first 7 characters of a commit, the 12 hex characters after `sha256:` of a digest. */
export function shortSha(value: string | null | undefined): string {
    if (!value) return '';
    const hex = value.startsWith('sha256:') ? value.slice(7) : value;
    return hex.slice(0, value.startsWith('sha256:') ? 12 : 7);
}

/**
 * An API code → the camelCase leaf an i18n sub-tree uses (`job_active` → `jobActive`). Unknown
 * codes are looked up with `t.has` by the caller and fall back to a generic sentence.
 */
export function codeLeaf(code: string | null | undefined): string {
    return String(code ?? '')
        .trim()
        .replace(/[^A-Za-z0-9_-]/g, '')
        .replace(/[-_]+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}
