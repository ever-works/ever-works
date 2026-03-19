'use client';

import { useState } from 'react';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslations } from 'next-intl';
import type { ComparisonData } from '@/lib/api/directory';
import { ROUTES } from '@/lib/constants';
import { formatComparisonDate } from '@/lib/utils/comparison';

interface ComparisonDetailClientProps {
    directoryId: string;
    comparison: ComparisonData;
    markdown?: string;
    extendedAnalysisMarkdown?: string;
}

function stripSourcesSection(markdown?: string): string | undefined {
    if (!markdown) return markdown;

    // We intentionally treat "Sources" as the final markdown section because
    // the structured UI block below is the canonical source presentation.
    return markdown
        .replace(/\n{2,}#{2,3}\s+Sources\s*[\s\S]*$/i, '')
        .replace(/\n{3,}$/g, '\n\n')
        .trim();
}

function WinnerBadge({
    winner,
    itemAName,
    itemBName,
}: {
    winner: 'item_a' | 'item_b' | 'tie';
    itemAName: string;
    itemBName: string;
}) {
    const t = useTranslations('dashboard.directoryDetail.comparisons');
    const name = winner === 'item_a' ? itemAName : winner === 'item_b' ? itemBName : t('tie');
    return (
        <span className="inline-flex items-center rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {t('winner', { name })}
        </span>
    );
}

function ScoreBar({ score, max = 10 }: { score: number; max?: number }) {
    const pct = Math.min(Math.max((score / max) * 100, 0), 100);
    return (
        <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-surface-hover dark:bg-surface-hover-dark overflow-hidden">
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-xs font-medium text-text-secondary dark:text-text-secondary-dark w-6 text-right">
                {score}
            </span>
        </div>
    );
}

export function ComparisonDetailClient({
    directoryId,
    comparison,
    markdown,
    extendedAnalysisMarkdown,
}: ComparisonDetailClientProps) {
    const t = useTranslations('dashboard.directoryDetail.comparisons');
    const [isExtendedOpen, setIsExtendedOpen] = useState(false);
    const hasStructuredSources = !!comparison.sources?.length;
    const articleMarkdown = hasStructuredSources ? stripSourcesSection(markdown) : markdown;

    return (
        <div className="space-y-8">
            {/* Back link */}
            <Link
                href={ROUTES.DASHBOARD_DIRECTORY_COMPARISONS(directoryId)}
                className="inline-flex items-center gap-1 text-sm text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors"
            >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M15 19l-7-7 7-7"
                    />
                </svg>
                {t('detail.backToComparisons')}
            </Link>

            {/* Title & meta */}
            <div>
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                    {comparison.title}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <span>
                        {comparison.item_a_name} {t('vs')} {comparison.item_b_name}
                    </span>
                    <span className="text-border dark:text-border-dark">|</span>
                    <span>{comparison.category}</span>
                    <span className="text-border dark:text-border-dark">|</span>
                    <span>{formatComparisonDate(comparison.generated_at)}</span>
                </div>
            </div>

            {/* Summary */}
            <section className="rounded-lg border border-border dark:border-border-dark p-4">
                <h2 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    {t('detail.summary')}
                </h2>
                <p className="text-text-secondary dark:text-text-secondary-dark">
                    {comparison.summary}
                </p>
            </section>

            {/* Dimensions */}
            {comparison.dimensions && comparison.dimensions.length > 0 && (
                <section>
                    <h2 className="text-lg font-medium text-text dark:text-text-dark mb-4">
                        {t('detail.dimensions')}
                    </h2>
                    <div className="space-y-4">
                        {comparison.dimensions.map((dim) => (
                            <div
                                key={dim.name}
                                className="rounded-lg border border-border dark:border-border-dark p-4"
                            >
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="font-medium text-text dark:text-text-dark">
                                        {dim.name}
                                    </h3>
                                    {dim.winner && (
                                        <WinnerBadge
                                            winner={dim.winner}
                                            itemAName={comparison.item_a_name}
                                            itemBName={comparison.item_b_name}
                                        />
                                    )}
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                    <div>
                                        <div className="text-sm font-medium text-text dark:text-text-dark mb-1">
                                            {comparison.item_a_name}
                                        </div>
                                        {dim.item_a_score != null && (
                                            <ScoreBar score={dim.item_a_score} />
                                        )}
                                        <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                            {dim.item_a_summary}
                                        </p>
                                    </div>
                                    <div>
                                        <div className="text-sm font-medium text-text dark:text-text-dark mb-1">
                                            {comparison.item_b_name}
                                        </div>
                                        {dim.item_b_score != null && (
                                            <ScoreBar score={dim.item_b_score} />
                                        )}
                                        <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                                            {dim.item_b_summary}
                                        </p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* Verdict */}
            <section className="rounded-lg border border-border dark:border-border-dark p-4">
                <h2 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    {t('detail.verdict')}
                </h2>
                {comparison.verdict_winner && (
                    <div className="mb-3">
                        <WinnerBadge
                            winner={comparison.verdict_winner}
                            itemAName={comparison.item_a_name}
                            itemBName={comparison.item_b_name}
                        />
                    </div>
                )}
                <p className="text-text-secondary dark:text-text-secondary-dark">
                    {comparison.verdict}
                </p>
            </section>

            {/* Markdown article */}
            {articleMarkdown && (
                <section>
                    <h2 className="text-lg font-medium text-text dark:text-text-dark mb-4">
                        {t('detail.article')}
                    </h2>
                    <div className="prose prose-sm dark:prose-invert prose-a:text-primary hover:prose-a:text-primary-hover max-w-none">
                        <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                                a: ({ node: _node, ...props }) => (
                                    <a {...props} target="_blank" rel="noopener noreferrer" />
                                ),
                            }}
                        >
                            {articleMarkdown}
                        </ReactMarkdown>
                    </div>
                </section>
            )}

            {/* Sources */}
            {hasStructuredSources && (
                <section className="rounded-lg border border-border dark:border-border-dark p-4">
                    <h2 className="text-lg font-medium text-text dark:text-text-dark mb-3">
                        {t('detail.sources')}
                    </h2>
                    <ul className="space-y-2">
                        {comparison.sources.map((source) => (
                            <li key={source.url}>
                                <div className="flex flex-col gap-1 text-sm sm:flex-row sm:items-baseline sm:gap-2">
                                    <span className="text-text dark:text-text-dark">
                                        {source.title}
                                    </span>
                                    <span className="hidden text-text-secondary dark:text-text-secondary-dark sm:inline">
                                        -
                                    </span>
                                    <a
                                        href={source.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="break-all text-primary underline underline-offset-2 hover:text-primary-hover"
                                    >
                                        {source.url}
                                    </a>
                                    {source.note && (
                                        <span className="text-text-secondary dark:text-text-secondary-dark">
                                            ({source.note})
                                        </span>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* Extended Analysis */}
            {extendedAnalysisMarkdown && (
                <section className="rounded-lg border border-border dark:border-border-dark">
                    <button
                        type="button"
                        onClick={() => setIsExtendedOpen(!isExtendedOpen)}
                        className="flex w-full items-center justify-between px-4 py-3 text-lg font-medium text-text dark:text-text-dark hover:bg-surface-hover dark:hover:bg-surface-hover-dark transition-colors rounded-lg"
                    >
                        <span>{t('detail.extendedAnalysis')}</span>
                        <svg
                            className={`h-5 w-5 text-text-muted transition-transform duration-200 ${isExtendedOpen ? 'rotate-180' : ''}`}
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M19 9l-7 7-7-7"
                            />
                        </svg>
                    </button>
                    {isExtendedOpen && (
                        <div className="border-t border-border dark:border-border-dark px-4 py-4">
                            <div className="prose prose-sm dark:prose-invert prose-a:text-primary hover:prose-a:text-primary-hover max-w-none">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        a: ({ node: _node, ...props }) => (
                                            <a
                                                {...props}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                            />
                                        ),
                                    }}
                                >
                                    {extendedAnalysisMarkdown}
                                </ReactMarkdown>
                            </div>
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}
