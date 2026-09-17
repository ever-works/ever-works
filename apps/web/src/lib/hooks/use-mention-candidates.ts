'use client';

import { useEffect, useState } from 'react';
import type { ConversationMentionCandidate } from '@ever-works/contracts';
import { listMentionCandidates } from '@/app/actions/dashboard/conversations';
import { parseWorkspacePath, serializeWorkspaceScope } from '@/lib/workspace-scope';

/** Keystrokes inside one quiet window collapse into one request (FR-26). */
export const MENTION_PICKER_DEBOUNCE_MS = 150;

type Fetcher = (query: string) => Promise<ConversationMentionCandidate[] | null>;

/**
 * Module-level caches, like `SlashCommandAutocomplete`'s skill cache: the
 * picker reopens on every `@`, and the same person typing the same prefix in
 * the same workspace gets the same answer.
 *
 *  - `answers` — the picker's result per (workspace, query);
 *  - `confirmed` — every candidate the server has ever returned for this
 *    person, per workspace. It is what the composer's highlight layer matches
 *    against: a name is lit up only once the server has confirmed that this
 *    person can address it (FR-29).
 */
const answers = new Map<string, ConversationMentionCandidate[]>();
const confirmed = new Map<string, Map<string, ConversationMentionCandidate>>();

async function defaultFetcher(query: string): Promise<ConversationMentionCandidate[] | null> {
    const result = await listMentionCandidates(query);
    return result.ok ? result.data.candidates : null;
}

function workspaceKey(): string {
    if (typeof window === 'undefined') return '';
    try {
        return serializeWorkspaceScope(parseWorkspacePath(window.location.pathname));
    } catch {
        return '';
    }
}

function remember(workspace: string, candidates: readonly ConversationMentionCandidate[]): void {
    let known = confirmed.get(workspace);
    if (!known) {
        known = new Map();
        confirmed.set(workspace, known);
    }
    for (const candidate of candidates) known.set(`${candidate.type}:${candidate.id}`, candidate);
}

/** Every candidate the server has confirmed for the visible workspace. */
export function confirmedMentionCandidates(): ConversationMentionCandidate[] {
    return [...(confirmed.get(workspaceKey())?.values() ?? [])];
}

/** Test seam: forget every cached answer. */
export function resetMentionCandidateCache(): void {
    answers.clear();
    confirmed.clear();
}

export interface MentionCandidatesState {
    candidates: ConversationMentionCandidate[];
    loading: boolean;
    /** Bumps whenever a new answer lands, so a highlight layer can re-match. */
    version: number;
}

/**
 * The mention picker's source: at most eight people and Agents the person
 * can address, for `query` (the text after `@`). `null` means the picker is
 * closed and nothing is fetched.
 */
export function useMentionCandidates(
    query: string | null,
    fetcher: Fetcher = defaultFetcher,
): MentionCandidatesState {
    const [state, setState] = useState<MentionCandidatesState>({
        candidates: [],
        loading: false,
        version: 0,
    });

    useEffect(() => {
        if (query === null) return;
        const workspace = workspaceKey();
        const key = `${workspace}|${query.toLowerCase()}`;
        const cached = answers.get(key);
        if (cached) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- a cache hit answers synchronously; there is no external system to subscribe to.
            setState((prev) => ({ candidates: cached, loading: false, version: prev.version }));
            return;
        }

        let cancelled = false;
        setState((prev) => ({ ...prev, loading: true }));
        const timer = setTimeout(() => {
            fetcher(query)
                .then((candidates) => {
                    if (cancelled) return;
                    if (candidates) {
                        answers.set(key, candidates);
                        remember(workspace, candidates);
                    }
                    setState((prev) => ({
                        candidates: candidates ?? [],
                        loading: false,
                        version: prev.version + 1,
                    }));
                })
                .catch(() => {
                    if (!cancelled)
                        setState((prev) => ({ ...prev, candidates: [], loading: false }));
                });
        }, MENTION_PICKER_DEBOUNCE_MS);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [query, fetcher]);

    return state;
}
