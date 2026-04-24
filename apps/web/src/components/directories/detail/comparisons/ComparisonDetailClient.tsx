'use client';

import { useState, useEffect } from 'react';
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
    return markdown
        .replace(/\n{2,}#{2,3}\s+Sources\s*[\s\S]*$/i, '')
        .replace(/\n{3,}$/g, '\n\n')
        .trim();
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function WinnerChip({ name }: { name: string }) {
    return (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-400/15 dark:bg-amber-400/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-400/30">
            <svg className="w-3 h-3 shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
            </svg>
            {name}
        </span>
    );
}

function TieBadge({ label }: { label: string }) {
    return (
        <span className="inline-flex items-center rounded-full bg-surface-hover dark:bg-surface-hover-dark px-2.5 py-0.5 text-[11px] font-medium text-text-secondary dark:text-text-secondary-dark ring-1 ring-inset ring-border dark:ring-border-dark">
            {label}
        </span>
    );
}

function ScoreBar({ score, max = 10, side }: { score: number; max?: number; side: 'a' | 'b' }) {
    const [width, setWidth] = useState(0);
    const pct = Math.min(Math.max((score / max) * 100, 0), 100);

    useEffect(() => {
        const t = setTimeout(() => setWidth(pct), 300);
        return () => clearTimeout(t);
    }, [pct]);

    return (
        <div className="flex items-center gap-2 mt-1.5">
            <div className="flex-1 h-0.5 rounded-full bg-black/8 dark:bg-white/10 overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                        side === 'a' ? 'bg-sky-500' : 'bg-violet-500'
                    }`}
                    style={{ width: `${width}%` }}
                />
            </div>
            <span className="text-xs font-semibold tabular-nums text-text-secondary dark:text-text-secondary-dark shrink-0 w-8 text-right">
                {score}
                <span className="font-normal opacity-40">/10</span>
            </span>
        </div>
    );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ComparisonDetailClient({
    directoryId,
    comparison,
    markdown,
    extendedAnalysisMarkdown,
}: ComparisonDetailClientProps) {
    const t = useTranslations('dashboard.directoryDetail.comparisons');
    const [isExtendedOpen, setIsExtendedOpen] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        const raf = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(raf);
    }, []);

    const hasStructuredSources = !!comparison.sources?.length;
    const articleMarkdown = hasStructuredSources ? stripSourcesSection(markdown) : markdown;

    const dimCount = comparison.dimensions?.length ?? 0;

    function resolveWinnerName(winner?: 'item_a' | 'item_b' | 'tie' | null) {
        if (winner === 'item_a') return comparison.item_a_name;
        if (winner === 'item_b') return comparison.item_b_name;
        return null;
    }

    const verdictWinnerName = resolveWinnerName(comparison.verdict_winner);
    const isTie = comparison.verdict_winner === 'tie';

    // shared enter animation helper
    function enter(delayMs: number) {
        return {
            className: `transition-all duration-500 ease-out ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
            }`,
            style: { transitionDelay: `${delayMs}ms` },
        };
    }

    return (
        <div className="space-y-5 pb-10">
            {/* ── Back link ──────────────────────────────────────────── */}
            <div {...enter(0)}>
                <Link
                    href={ROUTES.DASHBOARD_DIRECTORY_COMPARISONS(directoryId)}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-text-secondary dark:text-text-secondary-dark hover:text-text dark:hover:text-text-dark transition-colors group"
                >
                    <svg
                        className="w-3.5 h-3.5 transition-transform duration-200 group-hover:-translate-x-0.5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15 19l-7-7 7-7"
                        />
                    </svg>
                    {t('detail.backToComparisons')}
                </Link>
            </div>

            {/* ── Hero: A vs B ────────────────────────────────────────── */}
            <div
                {...enter(50)}
                className={`relative overflow-hidden rounded-2xl border border-border dark:border-border-dark transition-all duration-500 ease-out ${
                    mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
                }`}
            >
                {/* Ambient blobs */}
                <div className="pointer-events-none absolute inset-0">
                    <div className="absolute -left-16 -top-16 h-48 w-48 rounded-full bg-sky-500/10 blur-3xl dark:bg-sky-500/15" />
                    <div className="absolute -bottom-16 -right-16 h-48 w-48 rounded-full bg-violet-500/10 blur-3xl dark:bg-violet-500/15" />
                </div>

                <div className="relative px-6 py-7 sm:px-8">
                    {/* Meta chips */}
                    <div className="mb-5 flex flex-wrap items-center gap-2">
                        {comparison.category && (
                            <span className="rounded-full bg-black/5 px-2.5 py-0.5 text-[11px] font-medium text-text-secondary dark:bg-white/8 dark:text-text-secondary-dark">
                                {comparison.category}
                            </span>
                        )}
                        <span className="text-[11px] text-text-secondary dark:text-text-secondary-dark opacity-60">
                            {formatComparisonDate(comparison.generated_at)}
                        </span>
                    </div>

                    {/* Versus layout */}
                    <div className="flex items-center gap-4 sm:gap-6">
                        {/* Item A */}
                        <div className="min-w-0 flex-1">
                            <p className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-sky-500 dark:text-sky-400">
                                A
                            </p>
                            <h2 className="truncate text-xl font-bold leading-tight text-text dark:text-text-dark sm:text-2xl">
                                {comparison.item_a_name}
                            </h2>
                        </div>

                        {/* VS divider */}
                        <div className="flex shrink-0 flex-col items-center gap-1">
                            <div className="h-5 w-px bg-border dark:bg-border-dark" />
                            <span className="text-[9px] font-black uppercase tracking-widest text-text-secondary dark:text-text-secondary-dark opacity-50">
                                vs
                            </span>
                            <div className="h-5 w-px bg-border dark:bg-border-dark" />
                        </div>

                        {/* Item B */}
                        <div className="min-w-0 flex-1 text-right">
                            <p className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-violet-500 dark:text-violet-400">
                                B
                            </p>
                            <h2 className="truncate text-xl font-bold leading-tight text-text dark:text-text-dark sm:text-2xl">
                                {comparison.item_b_name}
                            </h2>
                        </div>
                    </div>

                    {/* Title */}
                    {comparison.title && (
                        <p className="mt-4 text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                            {comparison.title}
                        </p>
                    )}
                </div>
            </div>

            {/* ── Summary ─────────────────────────────────────────────── */}
            <div
                {...enter(100)}
                className={`rounded-xl border border-border dark:border-border-dark p-5 transition-all duration-500 ease-out ${
                    mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
                }`}
            >
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-widest text-text-secondary dark:text-text-secondary-dark opacity-50">
                    {t('detail.summary')}
                </p>
                <p className="text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                    {comparison.summary}
                </p>
            </div>

            {/* ── Dimensions ──────────────────────────────────────────── */}
            {dimCount > 0 && (
                <div
                    {...enter(150)}
                    className={`transition-all duration-500 ease-out ${
                        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
                    }`}
                >
                    <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-text-secondary dark:text-text-secondary-dark opacity-50">
                        {t('detail.dimensions')}
                    </p>

                    <div className="space-y-3">
                        {comparison.dimensions.map((dim, i) => {
                            const dimWinnerName = resolveWinnerName(dim.winner);
                            const dimIsTie = dim.winner === 'tie';
                            return (
                                <div
                                    key={dim.name}
                                    className={`overflow-hidden rounded-xl border border-border dark:border-border-dark transition-all duration-500 ease-out ${
                                        mounted
                                            ? 'opacity-100 translate-y-0'
                                            : 'opacity-0 translate-y-3'
                                    }`}
                                    style={{ transitionDelay: `${150 + i * 55}ms` }}
                                >
                                    {/* Dimension header bar */}
                                    <div className="flex items-center justify-between border-b border-border dark:border-border-dark bg-black/2 px-4 py-2.5 dark:bg-white/3">
                                        <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                                            {dim.name}
                                        </h3>
                                        {dimWinnerName && <WinnerChip name={dimWinnerName} />}
                                        {dimIsTie && <TieBadge label={t('tie')} />}
                                    </div>

                                    {/* Side-by-side scores */}
                                    <div className="grid grid-cols-2 divide-x divide-border dark:divide-border-dark">
                                        {/* Item A */}
                                        <div className="p-4">
                                            <p className="text-[10px] font-bold uppercase tracking-wider text-sky-500 dark:text-sky-400">
                                                {comparison.item_a_name}
                                            </p>
                                            {dim.item_a_score != null && (
                                                <ScoreBar score={dim.item_a_score} side="a" />
                                            )}
                                            <p className="mt-2 text-xs leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                                                {dim.item_a_summary}
                                            </p>
                                        </div>

                                        {/* Item B */}
                                        <div className="p-4">
                                            <p className="text-[10px] font-bold uppercase tracking-wider text-violet-500 dark:text-violet-400">
                                                {comparison.item_b_name}
                                            </p>
                                            {dim.item_b_score != null && (
                                                <ScoreBar score={dim.item_b_score} side="b" />
                                            )}
                                            <p className="mt-2 text-xs leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                                                {dim.item_b_summary}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* ── Verdict ─────────────────────────────────────────────── */}
            <div
                className={`relative overflow-hidden rounded-xl border border-amber-300/40 bg-amber-50/60 p-5 dark:border-amber-400/20 dark:bg-amber-400/5 transition-all duration-500 ease-out ${
                    mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
                }`}
                style={{ transitionDelay: `${150 + dimCount * 55 + 60}ms` }}
            >
                <div className="pointer-events-none absolute right-0 top-0 h-24 w-24 translate-x-1/3 -translate-y-1/3 rounded-full bg-amber-400/20 blur-2xl dark:bg-amber-400/10" />
                <div className="relative">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-600 dark:text-amber-400 opacity-70">
                            {t('detail.verdict')}
                        </p>
                        {verdictWinnerName && <WinnerChip name={verdictWinnerName} />}
                        {isTie && <TieBadge label={t('tie')} />}
                    </div>
                    <p className="text-sm leading-relaxed text-text-secondary dark:text-text-secondary-dark">
                        {comparison.verdict}
                    </p>
                </div>
            </div>

            {/* ── Article ─────────────────────────────────────────────── */}
            {articleMarkdown && (
                <div
                    className={`transition-all duration-500 ease-out ${
                        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
                    }`}
                    style={{ transitionDelay: `${150 + dimCount * 55 + 120}ms` }}
                >
                    <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-text-secondary dark:text-text-secondary-dark opacity-50">
                        {t('detail.article')}
                    </p>
                    <div className="rounded-xl border border-border dark:border-border-dark p-5 prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-text dark:prose-headings:text-text-dark prose-h1:text-base prose-h2:text-sm prose-h3:text-xs prose-h3:uppercase prose-h3:tracking-widest prose-p:text-xs prose-p:leading-relaxed prose-p:text-text-secondary dark:prose-p:text-text-secondary-dark prose-li:text-xs prose-li:text-text-secondary dark:prose-li:text-text-secondary-dark prose-a:text-primary hover:prose-a:text-primary-hover prose-strong:text-text dark:prose-strong:text-text-dark prose-strong:font-semibold prose-table:text-xs prose-th:font-semibold prose-th:text-text dark:prose-th:text-text-dark prose-td:text-text-secondary dark:prose-td:text-text-secondary-dark prose-hr:border-border dark:prose-hr:border-border-dark prose-blockquote:text-xs prose-blockquote:text-text-secondary dark:prose-blockquote:text-text-secondary-dark prose-blockquote:border-primary/40">
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
                </div>
            )}

            {/* ── Sources ─────────────────────────────────────────────── */}
            {hasStructuredSources && (
                <div
                    className={`rounded-xl border border-border dark:border-border-dark p-5 transition-all duration-500 ease-out ${
                        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
                    }`}
                    style={{ transitionDelay: `${150 + dimCount * 55 + 180}ms` }}
                >
                    <p className="mb-3 text-[10px] font-semibold uppercase tracking-widest text-text-secondary dark:text-text-secondary-dark opacity-50">
                        {t('detail.sources')}
                    </p>
                    <ul className="space-y-2">
                        {comparison.sources.map((source) => (
                            <li key={source.url} className="flex items-start gap-2.5 text-xs">
                                <span className="mt-0.5 shrink-0 text-text-secondary dark:text-text-secondary-dark opacity-30">
                                    ↗
                                </span>
                                <div className="min-w-0">
                                    <span className="font-medium text-text dark:text-text-dark">
                                        {source.title}
                                    </span>
                                    {' — '}
                                    <a
                                        href={source.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="break-all text-primary underline underline-offset-2 hover:text-primary-hover"
                                    >
                                        {source.url}
                                    </a>
                                    {source.note && (
                                        <span className="ml-1 text-text-secondary dark:text-text-secondary-dark opacity-60">
                                            ({source.note})
                                        </span>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* ── Extended Analysis ────────────────────────────────────── */}
            {extendedAnalysisMarkdown && (
                <div
                    className={`overflow-hidden rounded-xl border border-border dark:border-border-dark transition-all duration-500 ease-out ${
                        mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'
                    }`}
                    style={{ transitionDelay: `${150 + dimCount * 55 + 240}ms` }}
                >
                    <button
                        type="button"
                        onClick={() => setIsExtendedOpen(!isExtendedOpen)}
                        className="flex w-full items-center justify-between px-5 py-3.5 text-sm font-semibold text-text dark:text-text-dark transition-colors hover:bg-black/3 dark:hover:bg-white/4"
                    >
                        <div className="flex items-center gap-2">
                            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                            <span>{t('detail.extendedAnalysis')}</span>
                        </div>
                        <svg
                            className={`h-4 w-4 text-text-muted transition-transform duration-300 ${isExtendedOpen ? 'rotate-180' : ''}`}
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

                    <div
                        className={`overflow-hidden transition-all duration-300 ease-in-out ${
                            isExtendedOpen ? 'max-h-[3000px] opacity-100' : 'max-h-0 opacity-0'
                        }`}
                    >
                        <div className="border-t border-border dark:border-border-dark px-5 py-5 prose prose-sm dark:prose-invert max-w-none prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-text dark:prose-headings:text-text-dark prose-h1:text-base prose-h2:text-sm prose-h3:text-xs prose-h3:uppercase prose-h3:tracking-widest prose-p:text-xs prose-p:leading-relaxed prose-p:text-text-secondary dark:prose-p:text-text-secondary-dark prose-li:text-xs prose-li:text-text-secondary dark:prose-li:text-text-secondary-dark prose-a:text-primary hover:prose-a:text-primary-hover prose-strong:text-text dark:prose-strong:text-text-dark prose-strong:font-semibold prose-table:text-xs prose-th:font-semibold prose-th:text-text dark:prose-th:text-text-dark prose-td:text-text-secondary dark:prose-td:text-text-secondary-dark prose-hr:border-border dark:prose-hr:border-border-dark prose-blockquote:text-xs prose-blockquote:text-text-secondary dark:prose-blockquote:text-text-secondary-dark prose-blockquote:border-primary/40">
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm]}
                                components={{
                                    a: ({ node: _node, ...props }) => (
                                        <a {...props} target="_blank" rel="noopener noreferrer" />
                                    ),
                                }}
                            >
                                {extendedAnalysisMarkdown}
                            </ReactMarkdown>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
