'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * EW-641 slice B — shared autosave status/banner helper.
 *
 * Both the slice-A `MarkdownEditor` and the slice-B `TiptapEditor`
 * need the exact same plumbing:
 *
 *  1. A debounced `flush` driven by typing.
 *  2. A `SaveStatus` finite state machine: `idle → dirty → saving →
 *     saved | error`.
 *  3. A "Saved Ns ago" re-render every 1s while a `savedAt` is set.
 *  4. A `classifyServerError` helper that sniffs `HTTP 409` /
 *     `HTTP 423` / `conflict` / `locked` substrings out of the action
 *     envelope's `error` so the UI can branch on a discriminated
 *     `ServerErrorKind` instead of regex-matching twice.
 *
 * Slice A inlined all four pieces in `MarkdownEditor.tsx`. Slice B
 * extracts them here so the Tiptap editor can mirror the conflict /
 * locked banner shape verbatim without duplicating the logic. The
 * map for this slice explicitly calls out the move + use; the slice-A
 * MarkdownEditor will adopt it in a follow-up pass.
 */

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
export type ServerErrorKind = 'conflict' | 'locked' | 'generic';

export interface AutosaveFlushArgs {
    /** The candidate body the caller wants to persist. */
    candidate: string;
}

export interface AutosaveFlushResult {
    /** Truthy when the network call succeeded. */
    success: boolean;
    /** Body the server confirmed (might differ from candidate after normalisation). */
    confirmedBody?: string;
    /** Error message when `success === false` — sniffed for 409 / 423. */
    error?: string;
}

export interface UseAutosaveStatusOptions {
    /** Initial body — used to seed `lastSavedBody` so a no-op edit short-circuits. */
    initialBody: string;
    /** Debounce window. Tests pass 0 to flush synchronously. */
    debounceMs: number;
    /** Persist the candidate. Resolve `success: false` + `error: 'HTTP 409 …'` to surface the banner. */
    save: (args: AutosaveFlushArgs) => Promise<AutosaveFlushResult>;
}

export interface UseAutosaveStatus {
    status: SaveStatus;
    errorKind: ServerErrorKind | null;
    savedAt: number | null;
    /** Push a new body candidate and arm the debounce. */
    schedule: (next: string) => void;
    /** Reset the machine when the parent swaps documents. */
    reset: (nextBody: string) => void;
}

const HTTP_409_RE = /(\b409\b|conflict|version mismatch)/i;
const HTTP_423_RE = /(\b423\b|locked)/i;

export function classifyServerError(message: string | undefined): ServerErrorKind {
    if (!message) return 'generic';
    if (HTTP_409_RE.test(message)) return 'conflict';
    if (HTTP_423_RE.test(message)) return 'locked';
    return 'generic';
}

export function useAutosaveStatus({
    initialBody,
    debounceMs,
    save,
}: UseAutosaveStatusOptions): UseAutosaveStatus {
    const [status, setStatus] = useState<SaveStatus>('idle');
    const [errorKind, setErrorKind] = useState<ServerErrorKind | null>(null);
    const [savedAt, setSavedAt] = useState<number | null>(null);

    const lastSavedBodyRef = useRef<string>(initialBody);
    const pendingBodyRef = useRef<string>(initialBody);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savingRef = useRef(false);
    // Capture `save` in a ref so memoised callers don't have to also
    // memoise the save closure — the editor re-creates it per render
    // because it closes over the editor instance.
    const saveRef = useRef(save);
    saveRef.current = save;

    const flush = useCallback(() => {
        if (savingRef.current) return;
        const candidate = pendingBodyRef.current;
        if (candidate === lastSavedBodyRef.current) {
            setStatus('idle');
            return;
        }

        savingRef.current = true;
        setStatus('saving');
        setErrorKind(null);

        void (async () => {
            const result = await saveRef.current({ candidate });
            savingRef.current = false;

            if (result.success) {
                const confirmedBody = result.confirmedBody ?? candidate;
                lastSavedBodyRef.current = confirmedBody;
                setStatus('saved');
                setSavedAt(Date.now());
                // If the user typed more during the save, schedule a
                // follow-up flush so the latest content actually lands.
                if (pendingBodyRef.current !== confirmedBody) {
                    armDebounce();
                }
            } else {
                setErrorKind(classifyServerError(result.error));
                setStatus('error');
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const armDebounce = useCallback(() => {
        if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
        }
        if (debounceMs <= 0) {
            // Tests use 0 so the autosave path runs synchronously
            // after the next microtask.
            debounceRef.current = null;
            flush();
            return;
        }
        debounceRef.current = setTimeout(() => {
            debounceRef.current = null;
            flush();
        }, debounceMs);
    }, [debounceMs, flush]);

    const schedule = useCallback(
        (next: string) => {
            pendingBodyRef.current = next;
            if (!savingRef.current) {
                setStatus('dirty');
            }
            setErrorKind(null);
            armDebounce();
        },
        [armDebounce],
    );

    const reset = useCallback((nextBody: string) => {
        if (debounceRef.current !== null) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }
        lastSavedBodyRef.current = nextBody;
        pendingBodyRef.current = nextBody;
        savingRef.current = false;
        setStatus('idle');
        setErrorKind(null);
        setSavedAt(null);
    }, []);

    useEffect(() => {
        return () => {
            if (debounceRef.current !== null) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
        };
    }, []);

    return { status, errorKind, savedAt, schedule, reset };
}
