'use client';

import { useCallback, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import type { ConversationMentionCandidate } from '@ever-works/contracts';
import { CONVERSATION_DOCUMENT_REFERENCE_PREFIX } from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';
import { useMentionCandidates } from '@/lib/hooks/use-mention-candidates';

/** The `@` word the caret is in, or `null` when it is not in one. */
export interface ActiveMentionToken {
    /** Index of the `@`. */
    start: number;
    /** Text after the `@`, up to the caret. */
    query: string;
}

/** Characters that make an `@` part of a word (an email address, a handle) rather than a mention. */
const WORD_BEFORE_AT_RE = /[\p{L}\p{N}_.+-]/u;
/** What a query may contain: a name, including a two-word one being typed. */
const QUERY_RE = /^[\p{L}\p{N}_ -]{0,80}$/u;

/**
 * Find the `@` token the caret sits in. Mirrors the server rule for what can be
 * a mention: not inside a word, and never the document-reference syntax
 * (`@kb:slug`), which keeps working exactly as before (FR-33).
 */
export function findActiveMentionToken(text: string, caret: number): ActiveMentionToken | null {
    const before = text.slice(0, caret);
    const at = before.lastIndexOf('@');
    if (at === -1) return null;
    if (at > 0 && WORD_BEFORE_AT_RE.test(before[at - 1])) return null;
    const query = before.slice(at + 1);
    if (query.toLowerCase().startsWith(CONVERSATION_DOCUMENT_REFERENCE_PREFIX)) return null;
    // A second space ends a mention; one space may be the middle of a name.
    if (!QUERY_RE.test(query) || /\s\s/.test(query) || (query.match(/ /g) ?? []).length > 1) {
        return null;
    }
    return { start: at, query };
}

export interface MentionPickerState {
    open: boolean;
    query: string | null;
    candidates: ConversationMentionCandidate[];
    loading: boolean;
    activeIndex: number;
    setActiveIndex: (index: number) => void;
    pick: (candidate: ConversationMentionCandidate) => void;
    /** Tell the picker where the caret is, after every edit or caret move. */
    update: (text: string, caret: number) => void;
    /**
     * Call FIRST from the composer's `onKeyDown`; `true` means the picker
     * consumed the key (↑ ↓ Enter Tab Esc) and the composer must not act on it.
     */
    handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
    /** Candidate data changed — a highlight layer re-matches on this. */
    version: number;
}

export interface UseMentionPickerInput {
    textareaRef: { current: HTMLTextAreaElement | null };
    /** The composer text changed because a mention was inserted. */
    onInsert: (text: string) => void;
    disabled?: boolean;
}

/**
 * The `@` mention picker's state (FR-25..FR-28), with the keyboard model of
 * `SlashCommandAutocomplete`: ↑ ↓ move, Enter or Tab insert, Esc dismisses and
 * keeps the text exactly as typed. The composer's textarea stays uncontrolled:
 * the picker is told the text and caret, and writes the insertion back itself.
 */
export function useMentionPicker({
    textareaRef,
    onInsert,
    disabled = false,
}: UseMentionPickerInput): MentionPickerState {
    const [token, setToken] = useState<ActiveMentionToken | null>(null);
    // Dismissal and the highlighted row are stored against the token they
    // belong to, so typing on past a dismissed `@` never reopens it.
    const [dismissedAt, setDismissedAt] = useState<number | null>(null);
    const [active, setActive] = useState<{ key: string | null; index: number }>({
        key: null,
        index: 0,
    });

    const dismissed = token !== null && dismissedAt === token.start;
    const query = token && !dismissed && !disabled ? token.query : null;
    const { candidates, loading, version } = useMentionCandidates(query);
    const tokenKey = token ? `${token.start}:${token.query}` : null;
    const activeIndex = active.key === tokenKey ? active.index : 0;
    const setActiveIndex = useCallback(
        (index: number) => setActive({ key: tokenKey, index }),
        [tokenKey],
    );

    const update = useCallback((text: string, caret: number) => {
        const next = findActiveMentionToken(text, caret);
        setToken((prev) =>
            prev?.start === next?.start && prev?.query === next?.query ? prev : next,
        );
        if (!next) setDismissedAt(null);
    }, []);

    // A space may be the middle of a two-word name, but once nothing matches
    // it is just the sentence going on — close quietly instead of saying
    // "no match" under every word.
    const open = query !== null && (!query.includes(' ') || loading || candidates.length > 0);

    const pick = useCallback(
        (candidate: ConversationMentionCandidate) => {
            const el = textareaRef.current;
            if (!el || !token) return;
            const text = el.value;
            const end = token.start + 1 + token.query.length;
            const inserted = `@${candidate.name} `;
            const next = text.slice(0, token.start) + inserted + text.slice(end);
            el.value = next;
            const caret = token.start + inserted.length;
            el.setSelectionRange(caret, caret);
            el.focus();
            // The inserted name ends in a space the caret now follows; keep
            // this `@` dismissed so the picker does not reopen on its own name.
            setDismissedAt(token.start);
            onInsert(next);
        },
        [textareaRef, token, onInsert],
    );

    const handleKeyDown = useCallback(
        (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
            if (!open) return false;
            if (event.key === 'Escape') {
                event.preventDefault();
                if (token) setDismissedAt(token.start);
                return true;
            }
            if (candidates.length === 0) return false;
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex(Math.min(activeIndex + 1, candidates.length - 1));
                return true;
            }
            if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex(Math.max(activeIndex - 1, 0));
                return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
                const candidate = candidates[activeIndex];
                if (!candidate) return false;
                event.preventDefault();
                pick(candidate);
                return true;
            }
            return false;
        },
        [open, token, candidates, activeIndex, setActiveIndex, pick],
    );

    return {
        open,
        query,
        candidates,
        loading,
        activeIndex,
        setActiveIndex,
        pick,
        update,
        handleKeyDown,
        version,
    };
}

/**
 * The picker popup: at most eight rows, an Agent's status dot, the no-match
 * copy and the keyboard hint (spec §6.6). Anchored by the caller, whose
 * wrapper needs `position: relative`.
 */
export function MentionPicker({
    state,
    className,
}: {
    state: MentionPickerState;
    className?: string;
}) {
    const t = useTranslations('dashboard.aiChat.mentions');
    if (!state.open) return null;

    return (
        <div
            data-testid="conversation-mention-picker"
            className={cn(
                'absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden',
                'rounded-xl border border-border dark:border-border-dark',
                'bg-surface dark:bg-surface-dark shadow-lg',
                className,
            )}
        >
            {state.candidates.length > 0 ? (
                <div
                    role="listbox"
                    aria-label={t('pickerLabel')}
                    className="max-h-56 overflow-auto p-1"
                >
                    {state.candidates.map((candidate, index) => (
                        <button
                            key={`${candidate.type}:${candidate.id}`}
                            type="button"
                            role="option"
                            aria-selected={index === state.activeIndex}
                            // Keep focus in the textarea so the insertion lands in place.
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => state.pick(candidate)}
                            onMouseEnter={() => state.setActiveIndex(index)}
                            className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors',
                                index === state.activeIndex
                                    ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark'
                                    : 'text-text-secondary dark:text-text-secondary-dark',
                            )}
                        >
                            <span
                                aria-hidden="true"
                                className={cn(
                                    'h-1.5 w-1.5 shrink-0 rounded-full',
                                    candidate.status === 'active' || candidate.status === 'running'
                                        ? 'bg-success'
                                        : 'border border-text-muted',
                                )}
                            />
                            <span className="truncate font-medium">{candidate.name}</span>
                            <span className="ml-auto truncate font-mono text-[11px] text-text-muted dark:text-text-muted-dark">
                                @{candidate.slug}
                            </span>
                        </button>
                    ))}
                </div>
            ) : state.loading ? (
                <p className="px-3 py-2 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('loading')}
                </p>
            ) : (
                <div className="px-3 py-2 text-xs">
                    <p className="text-text dark:text-text-dark">
                        {t('noMatch', { query: state.query ?? '' })}
                    </p>
                    <p className="mt-0.5 text-text-muted dark:text-text-muted-dark">
                        {t('noMatchHint')}
                    </p>
                </div>
            )}
            <p className="border-t border-border dark:border-border-dark px-3 py-1 text-[10px] text-text-muted dark:text-text-muted-dark">
                {t('pickerHint')}
            </p>
        </div>
    );
}
