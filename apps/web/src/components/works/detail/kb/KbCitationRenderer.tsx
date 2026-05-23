'use client';

import { Fragment, useMemo } from 'react';
import { parseKbCitations } from '@/lib/kb/parse-kb-citations';
import { KbCitationHover } from './KbCitationHover';

/**
 * EW-641 Phase 2/c row 35d — conversation-message renderer that
 * detects `kb:{class}/{slug}` citation tokens in plain text and
 * wraps each one in `<KbCitationHover>` (row 35c). Surrounding
 * text segments render as-is.
 *
 * Bridges row 35a's parser (ported to the web side in
 * `apps/web/src/lib/kb/parse-kb-citations.ts`) and row 35c's
 * hover-card component so the chat surface can light up citations
 * end-to-end without further plumbing.
 *
 * Scope note: this component takes RAW TEXT. Wrapping a Markdown
 * surface (ChatMarkdown, MarkdownPreview, etc.) is out of scope —
 * citations inside code fences would be wrapped too. The intended
 * consumer is the assistant-message rendering path *before* the
 * Markdown layer takes over, OR a plain-text surface where the
 * citation should always be interactive. The follow-up row will
 * decide whether to introduce a remark plugin so citations inside
 * Markdown stay live too.
 *
 * Selectors locked:
 *  - `kb-citation-renderer` (root wrapper, with `data-citation-count`).
 *  - Each citation is a `<KbCitationHover>` (row 35c testids apply).
 *
 * Returns the wrapped text inside a `<span>` so callers can drop it
 * inline anywhere a text node is acceptable. If the text contains
 * no citations, renders a single `<span>` with the text — same
 * output shape so swapping `<KbCitationRenderer>` in / out of a
 * tree doesn't move the layout.
 */

export interface KbCitationRendererProps {
    /** Plain text from the assistant message (or any prose surface). */
    text: string;
    /** Owning Work scope for citation resolution (passed through). */
    workId: string;
}

export function KbCitationRenderer({ text, workId }: KbCitationRendererProps) {
    const segments = useMemo(() => {
        const citations = parseKbCitations(text);
        if (citations.length === 0) {
            return [{ kind: 'text' as const, value: text }];
        }
        const parts: Array<
            | { kind: 'text'; value: string }
            | { kind: 'citation'; cls: string; slug: string; raw: string; key: string }
        > = [];
        let cursor = 0;
        citations.forEach((c, i) => {
            if (c.startOffset > cursor) {
                parts.push({ kind: 'text', value: text.slice(cursor, c.startOffset) });
            }
            parts.push({
                kind: 'citation',
                cls: c.cls,
                slug: c.slug,
                raw: c.raw,
                // Keying on offset + index keeps stable identity even
                // when the same `{cls,slug}` appears multiple times.
                key: `${c.startOffset}-${i}`,
            });
            cursor = c.endOffset;
        });
        if (cursor < text.length) {
            parts.push({ kind: 'text', value: text.slice(cursor) });
        }
        return parts;
    }, [text]);

    const citationCount = segments.filter((s) => s.kind === 'citation').length;

    return (
        <span data-testid="kb-citation-renderer" data-citation-count={citationCount}>
            {segments.map((segment, i) => {
                if (segment.kind === 'text') {
                    // Use Fragment so the text segment doesn't introduce
                    // an extra wrapping `<span>` (saves DOM nodes when
                    // the prose is long).
                    return <Fragment key={`t-${i}`}>{segment.value}</Fragment>;
                }
                return (
                    <KbCitationHover
                        key={segment.key}
                        workId={workId}
                        cls={segment.cls as Parameters<typeof KbCitationHover>[0]['cls']}
                        slug={segment.slug}
                        raw={segment.raw}
                    />
                );
            })}
        </span>
    );
}
