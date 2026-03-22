'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

interface PluginReadmeProps {
    content: string;
}

export function PluginReadme({ content }: PluginReadmeProps) {
    return (
        <div className="prose prose-sm dark:prose-invert prose-a:text-primary hover:prose-a:text-primary-hover max-w-none">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
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
