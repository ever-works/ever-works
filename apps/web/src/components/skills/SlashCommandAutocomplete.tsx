'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils/cn';

/**
 * Skills feature — invocation slugs (`/plan`).
 *
 * Shared slash-command autocomplete for every composer whose text ends
 * up as an agent chat message. The SERVER is what actually resolves a
 * leading `/<invocation-slug>` (`AgentRunService`, chat-kind runs); this
 * is purely a discovery affordance, so every failure mode degrades to
 * "no popup, text submits as typed".
 *
 * Declared here rather than imported from `@/lib/api/skills` because
 * that module is `server-only` and these are client components.
 */
export interface InvocableSkillOption {
    id: string;
    title: string;
    invocationSlug: string;
    description: string;
}

/**
 * Module-level cache shared by every composer on the page — the list is
 * small and changes only when the user edits a skill, so one fetch per
 * page load is enough. A FAILED fetch is not cached, so the next `/`
 * keystroke retries.
 */
let cachedOptions: InvocableSkillOption[] | null = null;
let inflight: Promise<InvocableSkillOption[] | null> | null = null;

async function loadInvocableSkills(): Promise<InvocableSkillOption[] | null> {
    if (cachedOptions) return cachedOptions;
    if (!inflight) {
        inflight = (async () => {
            try {
                // eslint-disable-next-line no-restricted-syntax -- EW-789 baseline: unaudited, may be a real scope bug
                const res = await fetch('/api/skills/invocable', { cache: 'no-store' });
                if (!res.ok) return null;
                const body = (await res.json()) as { data?: InvocableSkillOption[] };
                cachedOptions = body.data ?? [];
                return cachedOptions;
            } catch {
                return null;
            } finally {
                inflight = null;
            }
        })();
    }
    return inflight;
}

/** Test seam — resets the cross-component cache between specs. */
export function __resetInvocableSkillsCache(): void {
    cachedOptions = null;
    inflight = null;
}

export interface UseSlashCommandsInput {
    /** Current composer text. */
    value: string;
    /** Replaces the whole composer text (the completion writes `/slug `). */
    onChange: (next: string) => void;
    /** Suppresses the popup while the input is disabled/sending. */
    disabled?: boolean;
    /** Refocused after a click-completion so typing continues in place. */
    inputRef?: { current: HTMLTextAreaElement | HTMLInputElement | null };
}

export interface SlashCommandsState {
    open: boolean;
    matches: InvocableSkillOption[];
    activeIndex: number;
    setActiveIndex: (index: number) => void;
    pick: (option: InvocableSkillOption) => void;
    /**
     * Call FIRST from the composer's own `onKeyDown`. Returns `true`
     * when the popup consumed the key (arrows / Tab / Enter / Escape) —
     * the caller must then return without running its own handling.
     */
    handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => boolean;
}

export function useSlashCommands({
    value,
    onChange,
    disabled = false,
    inputRef,
}: UseSlashCommandsInput): SlashCommandsState {
    const [options, setOptions] = useState<InvocableSkillOption[] | null>(cachedOptions);
    const loadedRef = useRef(options !== null);

    // Only a `/` at the very START of the message is a command — that is
    // the exact shape the server-side parser accepts, so the popup never
    // promises a completion the run pipeline would ignore.
    const query = useMemo(() => {
        const match = /^\/([a-z0-9-]*)$/i.exec(value);
        return match ? match[1].toLowerCase() : null;
    }, [value]);

    // Dismissal and the highlighted row are both stored AGAINST the query
    // they belong to and derived back out, rather than reset from an
    // effect on `query` — a setState in an effect body cascades a render
    // (react-hooks/set-state-in-effect) and this component re-renders on
    // every keystroke.
    const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
    const [active, setActive] = useState<{ query: string | null; index: number }>({
        query: null,
        index: 0,
    });
    const dismissed = query !== null && dismissedQuery === query;
    const activeIndex = active.query === query ? active.index : 0;
    const setActiveIndex = useCallback((index: number) => setActive({ query, index }), [query]);

    useEffect(() => {
        if (query === null || loadedRef.current || dismissed) return;
        let cancelled = false;
        void (async () => {
            const loaded = await loadInvocableSkills();
            if (cancelled) return;
            // A null result means the fetch failed: show nothing, but do
            // NOT mark it loaded so a later keystroke can retry.
            if (loaded) loadedRef.current = true;
            setOptions(loaded ?? []);
        })();
        return () => {
            cancelled = true;
        };
    }, [query, dismissed]);

    const matches = useMemo(() => {
        if (query === null || dismissed || !options) return [];
        return options.filter((option) => option.invocationSlug.startsWith(query));
    }, [query, dismissed, options]);

    const open = matches.length > 0 && !disabled;

    const pick = useCallback(
        (option: InvocableSkillOption) => {
            // The completion appends a space, so the value stops matching
            // the command shape and the popup closes on its own; the
            // dismissal below only covers a slug that completes to itself.
            onChange(`/${option.invocationSlug} `);
            setDismissedQuery(query);
            inputRef?.current?.focus();
        },
        [onChange, inputRef, query],
    );

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>): boolean => {
            if (!open) return false;
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex(Math.min(activeIndex + 1, matches.length - 1));
                return true;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex(Math.max(activeIndex - 1, 0));
                return true;
            }
            if (event.key === 'Tab' || event.key === 'Enter') {
                const option = matches[activeIndex];
                if (option) {
                    event.preventDefault();
                    pick(option);
                    return true;
                }
                return false;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                setDismissedQuery(query);
                return true;
            }
            return false;
        },
        [open, matches, activeIndex, setActiveIndex, pick, query],
    );

    return { open, matches, activeIndex, setActiveIndex, pick, handleKeyDown };
}

/**
 * Presentational popup for `useSlashCommands`. Anchored by the caller
 * (the wrapper needs `position: relative`); rendered only when open.
 */
export function SlashCommandPopup({
    state,
    className,
}: {
    state: SlashCommandsState;
    className?: string;
}) {
    if (!state.open) return null;
    return (
        <div
            role="listbox"
            aria-label="Skill slash commands"
            data-testid="composer-slash-popup"
            className={cn(
                'absolute bottom-full left-0 right-0 z-50 mb-2 max-h-56 overflow-auto',
                'rounded-xl border border-border dark:border-border-dark',
                'bg-surface dark:bg-surface-dark shadow-lg p-1',
                className,
            )}
        >
            {state.matches.map((option, i) => (
                <button
                    key={option.id}
                    type="button"
                    role="option"
                    aria-selected={i === state.activeIndex}
                    // Keep focus in the textarea so the completion lands
                    // without a blur/refocus flicker.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => state.pick(option)}
                    onMouseEnter={() => state.setActiveIndex(i)}
                    className={cn(
                        'flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
                        i === state.activeIndex
                            ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark'
                            : 'text-text-secondary dark:text-text-secondary-dark',
                    )}
                >
                    <span className="font-mono text-primary shrink-0">
                        /{option.invocationSlug}
                    </span>
                    <span className="truncate text-text-muted dark:text-text-muted-dark text-xs">
                        {option.title}
                    </span>
                </button>
            ))}
        </div>
    );
}
