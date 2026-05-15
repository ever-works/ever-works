'use client';

import { memo, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils/cn';

interface MarkdownPreviewProps {
    content: string;
}

// Mirrors the typography of the rendered directory site so authors get a
// reasonable approximation of what their item page will look like. The
// site itself uses `next-mdx-remote` and exposes a few custom MDX components
// (Tag/TagList) that this preview cannot render — those will show as their
// fallback text, which is documented in the spec.
const previewClass = cn(
    'prose prose-sm dark:prose-invert max-w-none',
    'prose-p:my-2 prose-p:leading-relaxed',
    'prose-headings:mt-4 prose-headings:mb-2 prose-headings:font-semibold',
    'prose-h1:text-base prose-h2:text-sm prose-h3:text-xs',
    'prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5',
    'prose-code:px-1 prose-code:py-0.5 prose-code:rounded',
    'prose-code:bg-black/5 dark:prose-code:bg-white/10',
    "prose-code:before:content-[''] prose-code:after:content-['']",
    'prose-pre:my-2 prose-pre:rounded-md prose-pre:bg-black/5 dark:prose-pre:bg-white/5',
    'prose-table:my-2',
    'prose-a:text-primary prose-a:no-underline hover:prose-a:underline',
    'prose-blockquote:my-2 prose-blockquote:border-l-primary/30',
    'prose-hr:my-3 prose-hr:border-border dark:prose-hr:border-white/10',
);

const remarkPlugins = [remarkGfm];

function ScrollableTable(props: ComponentPropsWithoutRef<'table'>) {
    return (
        <div className="overflow-x-auto">
            <table className="min-w-full" {...props} />
        </div>
    );
}

const markdownComponents = {
    table: ScrollableTable,
};

export const MarkdownPreview = memo(function MarkdownPreview({ content }: MarkdownPreviewProps) {
    return (
        <div className={previewClass}>
            <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
                {content}
            </ReactMarkdown>
        </div>
    );
});
