'use client';

import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CalendarClock, FileText, Info } from 'lucide-react';
import type { RunReceipt } from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { formatCents, formatTokens } from './runs.shared';

/**
 * Run receipt (AW-09) — the itemised account of one run, as plain blocks in
 * a fixed order: summary, what went wrong (failures only), cost, activity,
 * files touched, knowledge cited, related work.
 *
 * Presentational only: the Runs page drawer and the session detail page both
 * render it from the same `RunReceipt` payload. Every figure keeps "not
 * measured" apart from zero, and every string from the run (summary, error,
 * paths) reaches the DOM as a text node — never as markup.
 */

function Section({
    title,
    children,
    testId,
}: {
    title: string;
    children: React.ReactNode;
    testId: string;
}) {
    return (
        <section className="space-y-2" data-testid={testId}>
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {title}
            </h3>
            {children}
        </section>
    );
}

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
    return (
        <div className="flex items-baseline justify-between gap-4 text-xs">
            <dt className="text-text-secondary dark:text-text-secondary-dark">{label}</dt>
            <dd
                className={cn(
                    'text-right tabular-nums',
                    muted ? 'text-text-muted' : 'text-text dark:text-text-dark font-medium',
                )}
            >
                {value}
            </dd>
        </div>
    );
}

export function RunReceiptView({
    receipt,
    showSessionLink = true,
}: {
    receipt: RunReceipt;
    /** Hidden on the session page itself, where the timeline is already shown. */
    showSessionLink?: boolean;
}) {
    const t = useTranslations('dashboard.runsPage.receipt');
    const locale = useLocale();
    const { row, cost, counts, filesTouched, knowledge } = receipt;
    const failed = row.status === 'failed';

    const settled = formatCents(cost.settledCents, locale);
    const metered = formatCents(cost.meteredCents, locale);
    const tokens = formatTokens(cost.tokens.total, locale);
    const splitReported =
        cost.tokens.input != null ||
        cost.tokens.output != null ||
        cost.tokens.cacheRead != null ||
        cost.tokens.cacheWrite != null;

    return (
        <div className="space-y-5" data-testid="run-receipt">
            <Section title={t('summary')} testId="run-receipt-summary">
                {row.summary ? (
                    <p className="text-sm text-text dark:text-text-dark whitespace-pre-wrap break-words">
                        {row.summary}
                    </p>
                ) : (
                    <p className="text-xs text-text-muted">{t('noSummary')}</p>
                )}
            </Section>

            {failed && (
                <Section title={t('error')} testId="run-receipt-error">
                    <div className="rounded-md border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 p-3 space-y-1">
                        <p className="flex items-center gap-1.5 text-[11px] font-medium text-red-700 dark:text-red-300">
                            <AlertTriangle className="w-3.5 h-3.5" aria-hidden />
                            {t('exactError')}
                        </p>
                        <p className="text-xs font-mono text-red-800 dark:text-red-200 whitespace-pre-wrap break-words">
                            {row.errorMessage ?? '—'}
                        </p>
                    </div>
                </Section>
            )}

            <Section title={cost.soFar ? t('costSoFar') : t('cost')} testId="run-receipt-cost">
                <dl className="space-y-1.5">
                    <Row
                        label={t('settled')}
                        value={settled ?? t('notAttributable')}
                        muted={settled == null}
                    />
                    {cost.detailRetained && (
                        <Row
                            label={t('metered')}
                            value={metered ?? t('noUsage')}
                            muted={metered == null}
                        />
                    )}
                    <Row
                        label={t('creditsLabel')}
                        value={
                            cost.creditsDebited == null
                                ? t('noCredits')
                                : t('credits', { count: cost.creditsDebited })
                        }
                        muted={cost.creditsDebited == null}
                    />
                    <Row
                        label={t('tokens')}
                        value={tokens ?? t('notReported')}
                        muted={tokens == null}
                    />
                </dl>
                {!splitReported && (
                    <p className="text-[11px] text-text-muted">{t('tokenSplitNotReported')}</p>
                )}
                {cost.detailRetained ? (
                    cost.lines.length > 0 && (
                        <ul className="divide-y divide-border/60 dark:divide-border-dark/60 rounded-md border border-border/60 dark:border-border-dark/60">
                            {cost.lines.map((line) => (
                                <li
                                    key={`${line.capability}:${line.modelId ?? ''}`}
                                    className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs"
                                    data-testid="run-receipt-cost-line"
                                >
                                    <span className="min-w-0 truncate">
                                        <span className="font-medium text-text dark:text-text-dark">
                                            {line.capability}
                                        </span>
                                        <span className="ml-2 font-mono text-text-muted">
                                            {line.modelId ?? t('noModel')}
                                        </span>
                                    </span>
                                    <span className="shrink-0 tabular-nums text-text-secondary dark:text-text-secondary-dark">
                                        {t('lineCalls', { count: line.calls })} ·{' '}
                                        {formatCents(line.costCents, locale)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )
                ) : (
                    <p
                        className="flex items-start gap-1.5 text-[11px] text-text-muted"
                        data-testid="run-receipt-retention"
                    >
                        <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden />
                        {t('retentionNotice')}
                    </p>
                )}
            </Section>

            <Section title={t('activity')} testId="run-receipt-activity">
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('counts', { messages: counts.messages, toolCalls: counts.toolCalls })}
                </p>
                {receipt.captureTruncated && (
                    <p className="text-[11px] text-text-muted">{t('captureCapped')}</p>
                )}
                {showSessionLink && (
                    <Link
                        href={ROUTES.DASHBOARD_AGENT_SESSION(row.id)}
                        className="inline-block text-xs text-primary hover:underline"
                        data-testid="run-receipt-session-link"
                    >
                        {t('openSession')}
                    </Link>
                )}
            </Section>

            <Section title={t('filesTouched')} testId="run-receipt-files">
                {filesTouched.length > 0 ? (
                    <>
                        <p className="text-[11px] text-text-muted">
                            {t('fileCount', { count: filesTouched.length })}
                        </p>
                        <ul className="space-y-0.5 font-mono text-[11px] text-text-secondary dark:text-text-secondary-dark">
                            {filesTouched.map((path) => (
                                <li key={path} className="truncate" title={path}>
                                    {path}
                                </li>
                            ))}
                        </ul>
                    </>
                ) : counts.filesTouched > 0 ? (
                    <p className="text-xs text-text-muted">
                        {t('filesCountOnly', { count: counts.filesTouched })}
                    </p>
                ) : (
                    <p className="text-xs text-text-muted">{t('noFiles')}</p>
                )}
            </Section>

            {knowledge.length > 0 && (
                <Section title={t('knowledge')} testId="run-receipt-knowledge">
                    <ul className="space-y-1">
                        {knowledge.map((citation) => (
                            <li
                                key={`${citation.documentId}:${citation.citedAt}`}
                                className="flex items-center gap-2 text-xs"
                            >
                                <FileText className="w-3.5 h-3.5 text-text-muted" aria-hidden />
                                <Link
                                    href={ROUTES.DASHBOARD_WORK_KB(citation.workId)}
                                    className="text-primary hover:underline font-mono truncate"
                                    title={t('openDocument')}
                                >
                                    {citation.documentId}
                                </Link>
                                {citation.relevanceScore != null && (
                                    <span className="text-text-muted tabular-nums">
                                        {t('knowledgeRelevance', {
                                            score: citation.relevanceScore.toFixed(2),
                                        })}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </Section>
            )}

            <Section title={t('relatedWork')} testId="run-receipt-related">
                <dl className="space-y-1.5">
                    {row.missionId ? (
                        <Row
                            label={t('mission')}
                            value={
                                <Link
                                    href={ROUTES.DASHBOARD_MISSION(row.missionId)}
                                    className="text-primary hover:underline"
                                >
                                    {row.missionTitle ?? row.missionId.slice(0, 8)}
                                </Link>
                            }
                        />
                    ) : (
                        <p className="text-xs text-text-muted" data-testid="run-receipt-no-mission">
                            {t('noMission')}
                        </p>
                    )}
                    {row.taskId && (
                        <Row
                            label={t('task')}
                            value={
                                <Link
                                    href={ROUTES.DASHBOARD_TASK(row.taskId)}
                                    className="text-primary hover:underline"
                                >
                                    {row.taskTitle ?? row.taskId.slice(0, 8)}
                                </Link>
                            }
                        />
                    )}
                    {row.workId && (
                        <Row
                            label={t('work')}
                            value={
                                <Link
                                    href={ROUTES.DASHBOARD_WORK(row.workId)}
                                    className="text-primary hover:underline"
                                >
                                    {row.workName ?? row.workId.slice(0, 8)}
                                </Link>
                            }
                        />
                    )}
                    <Row
                        label={t('agent')}
                        value={
                            <Link
                                href={ROUTES.DASHBOARD_AGENT(row.agentId)}
                                className="text-primary hover:underline"
                            >
                                {row.agentName ?? row.agentId.slice(0, 8)}
                            </Link>
                        }
                    />
                </dl>
                {row.scheduleKey && (
                    <Link
                        href={`${ROUTES.DASHBOARD_ACTIVITY}?view=schedules`}
                        className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        data-testid="run-receipt-schedule-link"
                    >
                        <CalendarClock className="w-3.5 h-3.5" aria-hidden />
                        {t('openSchedule')}
                    </Link>
                )}
            </Section>
        </div>
    );
}
