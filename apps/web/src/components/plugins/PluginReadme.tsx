'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface PluginReadmeProps {
    content: string;
}

export function PluginReadme({ content }: PluginReadmeProps) {
    return (
        <div className="prose prose-sm dark:prose-invert prose-a:text-primary hover:prose-a:text-primary-hover max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
    );
}
