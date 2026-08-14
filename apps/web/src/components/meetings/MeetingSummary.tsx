'use client';

import type { ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils/cn';

/**
 * Meeting detail — the stored AI summary of `/meetings/:id`.
 *
 * The summary is written as markdown: the prompt asks for a few sentences
 * of what was discussed and decided, then bullet action items. Rendered as
 * preformatted text those bullets arrived as literal `-` and `**` on one
 * flat block, so the part a reader actually scans for — the actions — had
 * no shape at all.
 *
 * Typography is tuned DOWN from the prose defaults: a summary lives inside
 * a card next to the transcript, so its headings stay near body size and
 * the outer margins are stripped, leaving the card's own padding to set
 * the frame.
 */

const summaryProse = cn(
    'prose prose-sm max-w-none dark:prose-invert',
    'text-sm leading-relaxed text-text dark:text-text-dark',
    // The card's padding owns the outer edge; prose margins would double it.
    '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
    'prose-p:my-3 prose-p:text-inherit',
    'prose-headings:mb-2 prose-headings:mt-4 prose-headings:font-semibold prose-headings:text-inherit',
    // `###` is the section marker the summarizer is asked for, so h3 holds
    // body size and separates by WEIGHT — a heading smaller than the text
    // under it reads as a caption, not a section.
    'prose-h1:text-base prose-h2:text-sm prose-h3:text-sm prose-h4:text-xs',
    'prose-ul:my-3 prose-ol:my-3 prose-li:my-1 prose-li:text-inherit',
    'marker:text-text-muted dark:marker:text-text-muted-dark',
    'prose-strong:font-semibold prose-strong:text-inherit',
    'prose-a:text-info prose-a:no-underline hover:prose-a:underline',
    'prose-code:rounded prose-code:bg-black/5 prose-code:px-1 prose-code:py-0.5',
    'prose-code:text-[11px] prose-code:font-normal dark:prose-code:bg-white/10',
    "prose-code:before:content-[''] prose-code:after:content-['']",
    'prose-pre:my-3 prose-pre:rounded-lg prose-pre:bg-surface prose-pre:text-[11px]',
    'dark:prose-pre:bg-surface-dark',
    'prose-blockquote:my-3 prose-blockquote:border-l-info/30 prose-blockquote:font-normal',
    'prose-blockquote:not-italic prose-blockquote:text-text-secondary',
    'dark:prose-blockquote:text-text-secondary-dark',
    'prose-hr:my-4 prose-hr:border-border dark:prose-hr:border-border-dark',
    'prose-table:my-3 prose-table:text-xs',
    'prose-th:border prose-th:border-border prose-th:bg-surface-secondary/60 prose-th:px-2 prose-th:py-1',
    'dark:prose-th:border-border-dark dark:prose-th:bg-white/5',
    'prose-td:border prose-td:border-border prose-td:px-2 prose-td:py-1',
    'dark:prose-td:border-border-dark',
);

const remarkPlugins = [remarkGfm];

/** Wide tables scroll inside the card rather than stretching it. */
function ScrollableTable(props: ComponentPropsWithoutRef<'table'>) {
    return (
        <div className="overflow-x-auto">
            <table className="min-w-full" {...props} />
        </div>
    );
}

/**
 * Security: the summary is model-written from a transcript a user pasted,
 * so a link in it is attacker-influenced text. Anything that is not
 * http(s) — `javascript:` above all — is defused rather than rendered,
 * and what survives opens without handing the opener over.
 */
function SafeAnchor({ href, ...props }: ComponentPropsWithoutRef<'a'>) {
    const safe = /^https?:/i.test(href ?? '');
    if (!safe) return <span {...props} />;
    return <a href={href} target="_blank" rel="noopener noreferrer" {...props} />;
}

const markdownComponents = {
    table: ScrollableTable,
    a: SafeAnchor,
};

export function MeetingSummary({ text }: { text: string }) {
    return (
        <div className={summaryProse} data-testid="meeting-summary-body">
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
                {text}
            </ReactMarkdown>
        </div>
    );
}
