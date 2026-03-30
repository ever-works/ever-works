'use client';

import { memo, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils/cn';

interface ChatMarkdownProps {
    content: string;
}

const markdownClass = cn(
    'prose prose-xs dark:prose-invert max-w-none',
    'prose-p:my-1 prose-p:leading-relaxed',
    'prose-headings:mt-3 prose-headings:mb-1 prose-headings:font-semibold',
    'prose-h1:text-sm prose-h2:text-[13px] prose-h3:text-xs',
    'prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5',
    'prose-code:text-[11px] prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:bg-black/5 dark:prose-code:bg-white/10 prose-code:before:content-none prose-code:after:content-none',
    'prose-pre:my-2 prose-pre:rounded-lg prose-pre:bg-black/5 dark:prose-pre:bg-white/5 prose-pre:text-[11px]',
    'prose-table:my-2 prose-table:text-[11px]',
    'prose-th:px-2 prose-th:py-1 prose-th:border prose-th:border-border dark:prose-th:border-white/10 prose-th:bg-surface-secondary/50 dark:prose-th:bg-white/5',
    'prose-td:px-2 prose-td:py-1 prose-td:border prose-td:border-border dark:prose-td:border-white/10',
    'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
    'prose-blockquote:my-2 prose-blockquote:border-l-primary/30 prose-blockquote:text-text-muted dark:prose-blockquote:text-text-muted-dark',
    'prose-hr:my-3 prose-hr:border-border dark:prose-hr:border-white/10',
    'prose-strong:font-semibold',
    'text-xs',
);

const remarkPlugins = [remarkGfm];

function ScrollableTable(props: ComponentPropsWithoutRef<'table'>) {
    return (
        <div className="overflow-x-auto">
            <table {...props} />
        </div>
    );
}

const markdownComponents = {
    table: ScrollableTable,
};

export const ChatMarkdown = memo(function ChatMarkdown({ content }: ChatMarkdownProps) {
    return (
        <div className={markdownClass}>
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
                {content}
            </ReactMarkdown>
        </div>
    );
});
