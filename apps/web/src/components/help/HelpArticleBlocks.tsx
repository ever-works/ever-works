'use client';

import { Fragment, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ExternalLink } from 'lucide-react';
import type {
    HelpBlock,
    HelpInline,
    HelpLinkTarget,
    HelpListItem,
    HelpNoteTone,
} from '@ever-works/contracts/api';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { formatHelpTarget, resolveHelpTarget } from '@/lib/help/help-target';

export interface HelpArticleBlocksProps {
    blocks: HelpBlock[];
    /** Open another article (or a heading in this one) — in the panel, or by navigating on the full page. */
    onOpenArticle: (target: string) => void;
    /** Prefix for heading element ids, so the drawer and the full page never collide on one id. */
    idPrefix?: string;
    /** Added to a block heading's level: 0 on the full page (h2…), 1 in the drawer (h3…). */
    headingOffset?: 0 | 1;
}

/**
 * Same-origin address of an article on the full page, unscoped. Render it
 * through the workspace-aware `Link` (or push it through the workspace-aware
 * router) so an Organization user stays under `/org/<slug>` — never put it on
 * a bare anchor.
 */
export function helpArticleHref(target: string): string {
    const hash = target.indexOf('#');
    return hash === -1
        ? `${ROUTES.DASHBOARD_HELP}/${target}`
        : `${ROUTES.DASHBOARD_HELP}/${target.slice(0, hash)}#${target.slice(hash + 1)}`;
}

/** A literal in-product path for a ROUTES key, or null for a builder or an unknown key. */
function screenHref(routeKey: string): string | null {
    const value = (ROUTES as Record<string, unknown>)[routeKey];
    return typeof value === 'string' && routeKey.startsWith('DASHBOARD') ? value : null;
}

/**
 * Whether a click on an in-app help link should be left to the browser (a new
 * tab or window, a download) instead of opening the article in place.
 */
export function isModifiedHelpClick(event: {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    button: number;
}): boolean {
    return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
}

/** An external address the renderer is willing to link: absolute `https:` with no credentials. */
export function safeExternalHref(href: string): string | null {
    try {
        const url = new URL(href);
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        return url.toString();
    } catch {
        return null;
    }
}

const LINK_CLASS =
    'font-medium text-primary underline-offset-2 hover:underline dark:text-primary-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-sm';

const NOTE_TONE_CLASS: Record<HelpNoteTone, string> = {
    note: 'border-border bg-surface dark:border-border-dark dark:bg-surface-secondary-dark',
    tip: 'border-emerald-300/60 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-950/30',
    info: 'border-sky-300/60 bg-sky-50 dark:border-sky-500/30 dark:bg-sky-950/30',
    warning: 'border-amber-300/60 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-950/30',
    danger: 'border-red-300/60 bg-red-50 dark:border-red-500/30 dark:bg-red-950/30',
};

/**
 * Renders an article body from the closed block grammar (AW-25, spec FR-27,
 * FR-27a, FR-28). Every node becomes a React element — there is no raw markup
 * path. Every link target is re-checked at render time: an article this build
 * does not have, a screen that is not a literal dashboard route, or an address
 * that is not plain `https:` renders its label as text with no link.
 */
export function HelpArticleBlocks({
    blocks,
    onOpenArticle,
    idPrefix = '',
    headingOffset = 0,
}: HelpArticleBlocksProps) {
    const t = useTranslations('dashboard.helpCenter');

    const renderTarget = (target: HelpLinkTarget, children: ReactNode, key: string): ReactNode => {
        switch (target.type) {
            case 'article': {
                const value = formatHelpTarget(target.articleId, target.headingId);
                if (!resolveHelpTarget(value)) return <Fragment key={key}>{children}</Fragment>;
                // The workspace-aware Link keeps `/org/<slug>` on the address a
                // modified click (new tab or window) follows.
                return (
                    <Link
                        key={key}
                        href={helpArticleHref(value)}
                        data-help-article-link={value}
                        onClick={(event) => {
                            if (isModifiedHelpClick(event)) return;
                            event.preventDefault();
                            onOpenArticle(value);
                        }}
                        className={LINK_CLASS}
                    >
                        {children}
                    </Link>
                );
            }
            case 'screen': {
                const href = screenHref(target.routeKey);
                if (!href) return <Fragment key={key}>{children}</Fragment>;
                return (
                    <Link key={key} href={href} className={LINK_CLASS}>
                        {children}
                    </Link>
                );
            }
            case 'external': {
                const href = safeExternalHref(target.href);
                if (!href) return <Fragment key={key}>{children}</Fragment>;
                return (
                    <a
                        key={key}
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(LINK_CLASS, 'inline-flex items-baseline gap-0.5')}
                    >
                        {children}
                        <ExternalLink className="h-3 w-3 shrink-0 self-center" aria-hidden="true" />
                        <span className="sr-only"> ({t('externalLink')})</span>
                    </a>
                );
            }
        }
    };

    const renderInline = (nodes: HelpInline[], keyPrefix: string): ReactNode[] =>
        nodes.map((node, index) => {
            const key = `${keyPrefix}-${index}`;
            switch (node.type) {
                case 'text':
                    return <Fragment key={key}>{node.text}</Fragment>;
                case 'strong':
                    return (
                        <strong key={key} className="font-semibold text-text dark:text-text-dark">
                            {renderInline(node.children, key)}
                        </strong>
                    );
                case 'emphasis':
                    return <em key={key}>{renderInline(node.children, key)}</em>;
                case 'code':
                    return (
                        <code
                            key={key}
                            className="rounded bg-surface px-1 py-0.5 font-mono text-[0.85em] dark:bg-surface-secondary-dark"
                        >
                            {node.text}
                        </code>
                    );
                case 'link':
                    return renderTarget(node.target, renderInline(node.children, key), key);
            }
        });

    const renderItems = (items: HelpListItem[], key: string) =>
        items.map((item, index) => (
            <li key={`${key}-${index}`} className="pl-1">
                {renderInline(item.content, `${key}-${index}-c`)}
                {item.children.length > 0 && (
                    <div className="mt-2 space-y-2">
                        {renderBlocks(item.children, `${key}-${index}-b`)}
                    </div>
                )}
            </li>
        ));

    const renderBlocks = (list: HelpBlock[], keyPrefix: string): ReactNode[] =>
        list.map((block, index) => {
            const key = `${keyPrefix}-${index}`;
            switch (block.kind) {
                case 'paragraph':
                    return (
                        <p key={key} className="leading-relaxed">
                            {renderInline(block.content, key)}
                        </p>
                    );
                case 'heading': {
                    const level = Math.min(block.level + headingOffset, 6);
                    const Tag = `h${level}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
                    return (
                        <Tag
                            key={key}
                            id={`${idPrefix}${block.id}`}
                            data-help-heading={block.id}
                            className={cn(
                                'scroll-mt-4 font-semibold text-text dark:text-text-dark',
                                block.level === 2 ? 'pt-3 text-base' : 'pt-2 text-sm',
                            )}
                        >
                            {renderInline(block.content, key)}
                        </Tag>
                    );
                }
                case 'orderedList':
                    return (
                        <ol key={key} className="list-decimal space-y-1.5 pl-5">
                            {renderItems(block.items, key)}
                        </ol>
                    );
                case 'unorderedList':
                    return (
                        <ul key={key} className="list-disc space-y-1.5 pl-5">
                            {renderItems(block.items, key)}
                        </ul>
                    );
                case 'note':
                    return (
                        <aside
                            key={key}
                            role="note"
                            data-tone={block.tone}
                            className={cn(
                                'space-y-2 rounded-lg border px-3 py-2.5',
                                NOTE_TONE_CLASS[block.tone],
                            )}
                        >
                            {block.title && (
                                <p className="font-semibold text-text dark:text-text-dark">
                                    {block.title}
                                </p>
                            )}
                            {renderBlocks(block.blocks, key)}
                        </aside>
                    );
                case 'shortcut':
                    return (
                        <p key={key} className="flex flex-wrap items-center gap-2">
                            <span className="flex items-center gap-1">
                                {block.keys.map((keyName, keyIndex) => (
                                    <kbd
                                        key={`${key}-k${keyIndex}`}
                                        className="min-w-[1.5rem] rounded border border-border bg-surface px-1.5 py-0.5 text-center text-[11px] font-medium dark:border-border-dark dark:bg-surface-dark"
                                    >
                                        {keyName}
                                    </kbd>
                                ))}
                            </span>
                            <span>{block.label}</span>
                        </p>
                    );
                case 'code':
                    return (
                        <pre
                            key={key}
                            data-language={block.language ?? undefined}
                            className="max-w-full overflow-x-auto rounded-lg border border-border bg-surface p-3 font-mono text-xs leading-relaxed dark:border-border-dark dark:bg-surface-secondary-dark"
                        >
                            <code>{block.text}</code>
                        </pre>
                    );
                case 'link':
                    return <p key={key}>{renderTarget(block.target, block.label, key)}</p>;
                case 'table':
                    return (
                        <div
                            key={key}
                            className="max-w-full overflow-x-auto rounded-lg border border-border dark:border-border-dark"
                        >
                            <table className="min-w-full border-collapse text-left text-xs">
                                <thead className="bg-surface dark:bg-surface-secondary-dark">
                                    <tr>
                                        {block.header.map((cell, cellIndex) => (
                                            <th
                                                key={`${key}-h${cellIndex}`}
                                                scope="col"
                                                className="border-b border-border px-2.5 py-1.5 font-semibold dark:border-border-dark"
                                            >
                                                {renderInline(cell, `${key}-h${cellIndex}`)}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {block.rows.map((row, rowIndex) => (
                                        <tr
                                            key={`${key}-r${rowIndex}`}
                                            className="border-b border-border last:border-b-0 dark:border-border-dark"
                                        >
                                            {row.map((cell, cellIndex) => (
                                                <td
                                                    key={`${key}-r${rowIndex}-${cellIndex}`}
                                                    className="px-2.5 py-1.5 align-top"
                                                >
                                                    {renderInline(
                                                        cell,
                                                        `${key}-r${rowIndex}-${cellIndex}`,
                                                    )}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    );
            }
        });

    return (
        <div
            dir="ltr"
            lang="en"
            className="space-y-3 text-sm text-text-secondary dark:text-text-secondary-dark"
        >
            {renderBlocks(blocks, 'b')}
        </div>
    );
}
