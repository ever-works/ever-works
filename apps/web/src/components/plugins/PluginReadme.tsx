'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';

interface PluginReadmeProps {
    content: string;
}

// H-12: pair `rehype-raw` with `rehype-sanitize` so plugin-readme HTML
// can't ship `<script>` / `<iframe srcdoc>` / `<img onerror>` etc. The
// default schema covers the common safe-HTML cases (links, images, code
// blocks, basic tables) which is what plugin authors actually need.
// We extend it slightly to keep `className` on anchors/code so the prose
// styling still works.
const sanitizeSchema = {
    ...defaultSchema,
    attributes: {
        ...defaultSchema.attributes,
        a: [...(defaultSchema.attributes?.a ?? []), 'className'],
        code: [...(defaultSchema.attributes?.code ?? []), 'className'],
    },
};

export function PluginReadme({ content }: PluginReadmeProps) {
    return (
        <div className="prose prose-sm prose-p:w-5/6 dark:prose-invert prose-a:text-primary hover:prose-a:text-primary-hover max-w-none">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                // Order matters: rehype-raw parses raw HTML into the tree,
                // rehype-sanitize then strips anything dangerous from it.
                rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
                components={{
                    code: ({ children, className, ...props }) => {
                        if (className) {
                            return (
                                <code className={className} {...props}>
                                    {children}
                                </code>
                            );
                        }
                        return (
                            <code
                                className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono"
                                {...props}
                            >
                                {children}
                            </code>
                        );
                    },
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
}
