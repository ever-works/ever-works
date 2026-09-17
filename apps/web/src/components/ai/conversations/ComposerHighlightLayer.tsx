'use client';

import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {
    findConversationDocumentReferences,
    parseConversationMentions,
    type ConversationMentionCandidateSource,
} from '@ever-works/contracts';
import { cn } from '@/lib/utils/cn';

export interface ComposerHighlightHandle {
    /** Repaint for the textarea's current text and scroll offset. */
    update: (text: string, scrollTop: number) => void;
    /** Re-match the same text — newly confirmed candidates may now resolve. */
    repaint: () => void;
}

/** One painted stretch of the composer text. */
export interface HighlightSegment {
    text: string;
    kind: 'plain' | 'mention' | 'document';
}

/**
 * Split `text` into plain, mention and document stretches. A mention is
 * painted ONLY when it resolves against `candidates` — people and Agents the
 * server confirmed this person can address — using the very rule the server
 * applies when the message is sent, so a highlight always means the mention
 * lands and an `@` word that does not resolve stays plain (FR-28, FR-29).
 * `@kb:slug` document references keep their existing syntax and are painted
 * as references (FR-33).
 */
export function highlightSegments(
    text: string,
    candidates: readonly ConversationMentionCandidateSource[],
): HighlightSegment[] {
    return paintComposerText(text, candidates).segments;
}

/** The painted stretches, and how many resolvable mentions fall past the ten-mention cap. */
export function paintComposerText(
    text: string,
    candidates: readonly ConversationMentionCandidateSource[],
): { segments: HighlightSegment[]; overLimit: number } {
    const parsed = parseConversationMentions(text, candidates);
    const marks = [
        ...parsed.spans.map((span) => ({
            start: span.start,
            end: span.start + span.length,
            kind: 'mention' as const,
        })),
        ...findConversationDocumentReferences(text).map((reference) => ({
            start: reference.start,
            end: reference.start + reference.length,
            kind: 'document' as const,
        })),
    ].sort((a, b) => a.start - b.start);

    const segments: HighlightSegment[] = [];
    let cursor = 0;
    for (const mark of marks) {
        if (mark.start < cursor) continue;
        if (mark.start > cursor)
            segments.push({ text: text.slice(cursor, mark.start), kind: 'plain' });
        segments.push({ text: text.slice(mark.start, mark.end), kind: mark.kind });
        cursor = mark.end;
    }
    if (cursor < text.length) segments.push({ text: text.slice(cursor), kind: 'plain' });
    return { segments, overLimit: parsed.overLimit };
}

export interface ComposerHighlightLayerProps {
    ref?: Ref<ComposerHighlightHandle>;
    /** Confirmed candidates, read at paint time. */
    getCandidates: () => readonly ConversationMentionCandidateSource[];
    /** Must match the textarea's box: padding, font size and line height. */
    className?: string;
    /** More resolvable mentions than one message carries — the composer says so before sending (FR-31). */
    onOverLimitChange?: (overLimit: boolean) => void;
}

/**
 * The layer behind the composer's textarea that lights up resolved mentions
 * and document references (plan D6).
 *
 * The textarea stays uncontrolled — making it controlled would re-render the
 * whole panel on every keystroke. Instead the composer calls `update()` with
 * the text it already has, and only this layer re-renders. The layer is
 * `aria-hidden` and ignores the pointer; its text is transparent, so the
 * textarea's own glyphs (drawn on top, over a transparent background) are
 * what the person reads, with the highlight showing through behind them.
 */
export function ComposerHighlightLayer({
    ref,
    getCandidates,
    className,
    onOverLimitChange,
}: ComposerHighlightLayerProps) {
    const [view, setView] = useState({ text: '', scrollTop: 0, generation: 0 });

    useImperativeHandle(
        ref,
        () => ({
            update: (text, scrollTop) =>
                setView((prev) =>
                    prev.text === text && prev.scrollTop === scrollTop
                        ? prev
                        : { ...prev, text, scrollTop },
                ),
            repaint: () => setView((prev) => ({ ...prev, generation: prev.generation + 1 })),
        }),
        [],
    );

    const { segments, overLimit } = paintComposerText(view.text, getCandidates());
    const painted = segments.some((segment) => segment.kind !== 'plain');
    const over = overLimit > 0;
    const onOverLimitRef = useRef(onOverLimitChange);
    useEffect(() => {
        onOverLimitRef.current = onOverLimitChange;
    });
    useEffect(() => {
        onOverLimitRef.current?.(over);
    }, [over]);

    return (
        <div
            aria-hidden="true"
            data-testid="composer-highlight-layer"
            className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
        >
            {painted && (
                <div
                    className="whitespace-pre-wrap break-words text-transparent"
                    style={{ transform: `translateY(${-view.scrollTop}px)` }}
                >
                    {segments.map((segment, index) =>
                        segment.kind === 'plain' ? (
                            <span key={index}>{segment.text}</span>
                        ) : (
                            <mark
                                key={index}
                                data-highlight={segment.kind}
                                className={cn(
                                    'rounded-sm text-transparent',
                                    segment.kind === 'mention'
                                        ? 'bg-primary/15 dark:bg-primary/30'
                                        : 'bg-concept-agents/15 dark:bg-concept-agents/25',
                                )}
                            >
                                {segment.text}
                            </mark>
                        ),
                    )}
                    {/* A trailing newline needs a glyph to take up its line. */}
                    {'\u200b'}
                </div>
            )}
        </div>
    );
}
