'use client';

import { Directory } from '@/lib/api/types-only';
import { cn } from '@/lib/utils/cn';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { getStepProgress, getStepText, getItemsProcessedText } from '@/lib/utils/generator-steps';
import { Terminal, Info, ChevronDown, ChevronUp } from 'lucide-react';
import { TerminalLogViewer } from '../shared/TerminalLogViewer';

// ─── Animated orb ────────────────────────────────────────────────────────────

function GeneratingOrb() {
    return (
        <div
            className="relative flex items-center justify-center"
            style={{ width: 156, height: 156 }}
        >
            <span className="gp-pulse-ring" aria-hidden />
            <span className="gp-pulse-ring" aria-hidden />
            <div
                className="relative flex items-center justify-center"
                style={{ width: 120, height: 120 }}
            >
                <svg
                    className="absolute inset-0 gp-orbit-cw"
                    width="120"
                    height="120"
                    viewBox="-60 -60 120 120"
                    aria-hidden
                >
                    <circle
                        r="55"
                        fill="none"
                        stroke="var(--gp-ring-stroke)"
                        strokeWidth="1"
                        strokeDasharray="6 5"
                    />
                    <circle cx="55" cy="0" r="3" fill="var(--gp-dot-hi)" />
                    <circle cx="-55" cy="0" r="1.5" fill="var(--gp-dot-lo)" />
                    <circle cx="0" cy="55" r="2" fill="var(--gp-dot-mid)" />
                </svg>

                <svg
                    className="absolute inset-0 gp-orbit-ccw"
                    width="120"
                    height="120"
                    viewBox="-60 -60 120 120"
                    aria-hidden
                >
                    <circle
                        r="40"
                        fill="none"
                        stroke="var(--gp-ring-stroke)"
                        strokeWidth="1"
                        strokeDasharray="3 9"
                    />
                    <circle cx="40" cy="0" r="2" fill="var(--gp-dot-hi)" />
                    <circle cx="-30" cy="-26" r="1.5" fill="var(--gp-dot-lo)" />
                </svg>

                <div
                    className="absolute rounded-full blur-2xl"
                    style={{ width: 60, height: 60, background: 'var(--gp-glow)' }}
                    aria-hidden
                />

                <div
                    className="relative z-10 flex items-center justify-center rounded-full"
                    style={{
                        width: 72,
                        height: 72,
                        background: 'var(--gp-core-bg)',
                        boxShadow: 'var(--gp-core-shadow)',
                    }}
                >
                    <svg
                        className="absolute inset-0 gp-arc"
                        width="72"
                        height="72"
                        viewBox="-36 -36 72 72"
                        aria-hidden
                    >
                        <circle
                            r="30"
                            fill="none"
                            stroke="var(--gp-arc-stroke)"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeDasharray="60 128"
                        />
                    </svg>
                </div>
            </div>
        </div>
    );
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function ProgressBar({ percentage }: { percentage: number }) {
    return (
        <div
            className="relative w-full h-0.75 rounded-full overflow-hidden"
            style={{ background: 'var(--gp-bar-track)' }}
        >
            <div
                className="absolute inset-y-0 left-0 rounded-full overflow-hidden transition-[width] duration-700 ease-out"
                style={{ width: `${percentage}%`, background: 'var(--gp-bar-fill)' }}
            >
                <div className="gp-shimmer" aria-hidden />
            </div>
        </div>
    );
}

interface GenerationProgressProps {
    directory: Directory;
}

export function GenerationProgress({ directory }: GenerationProgressProps) {
    const t = useTranslations('dashboard.directoryDetail.progress');
    const [dots, setDots] = useState('');
    const [showLogs, setShowLogs] = useState(true);

    useEffect(() => {
        const interval = setInterval(() => {
            setDots((prev) => (prev.length >= 3 ? '' : prev + '.'));
        }, 500);
        return () => clearInterval(interval);
    }, []);

    const generateStatus = directory.generateStatus;
    const progressPercentage = getStepProgress(generateStatus);
    const stepText = getStepText(generateStatus, t('steps.processing'));
    const itemsText = getItemsProcessedText(generateStatus);
    const recentLogs = generateStatus?.recentLogs;
    const hasLogs = recentLogs && recentLogs.length > 0;

    return (
        <div className="gp-enter max-w-2xl mx-auto py-12">
            <div
                className={cn(
                    'rounded-xl border overflow-hidden',
                    'bg-card dark:bg-transparent',
                    'border-card-border dark:border-border-secondary-dark',
                )}
            >
                <div className="relative flex flex-col items-center px-8 pt-10 pb-6 text-center overflow-hidden">
                    <div
                        className="absolute -top-10 left-1/2 -translate-x-1/2 w-64 h-36 rounded-full blur-3xl pointer-events-none"
                        style={{ background: 'var(--gp-hero-glow)' }}
                        aria-hidden
                    />

                    <GeneratingOrb />

                    <div className="mt-5 space-y-1.5">
                        <h2 className="text-lg font-semibold tracking-tight text-text dark:text-text-dark">
                            {t('title')}
                            {dots}
                        </h2>
                        <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-xs mx-auto leading-relaxed">
                            {stepText}
                        </p>
                        {itemsText && (
                            <p className="text-xs font-medium tabular-nums text-text-muted dark:text-text-muted-dark">
                                {itemsText}
                            </p>
                        )}
                    </div>
                </div>

                {/* ── Progress bar ── */}
                <div className="px-8 pb-6">
                    <div className="flex justify-between items-center mb-2">
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('progress')}
                        </span>
                        <span className="text-xs font-semibold tabular-nums text-text dark:text-text-dark">
                            {progressPercentage}%
                        </span>
                    </div>
                    <ProgressBar percentage={progressPercentage} />
                </div>

                {hasLogs && (
                    <div className="px-8 pb-4 space-y-3">
                        <button
                            type="button"
                            onClick={() => setShowLogs((prev) => !prev)}
                            className={cn(
                                'group inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200',
                                showLogs
                                    ? 'bg-white/6 text-text dark:text-text-dark ring-1 ring-white/15'
                                    : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-secondary dark:text-text-secondary-dark hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                            )}
                        >
                            <Terminal className="h-3.5 w-3.5 transition-transform duration-200 group-hover:scale-110" />
                            {showLogs ? t('hideLogs') : t('showLogs')}
                            {showLogs ? (
                                <ChevronUp className="h-3 w-3 ml-0.5 opacity-40" />
                            ) : (
                                <ChevronDown className="h-3 w-3 ml-0.5 opacity-40" />
                            )}
                        </button>

                        {showLogs && (
                            <TerminalLogViewer
                                logs={recentLogs!}
                                title={t('showLogs')}
                                showCursor
                            />
                        )}
                    </div>
                )}

                <div className="mx-8 mb-6 mt-2 flex items-start gap-2.5 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark px-4 py-3">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-text-muted dark:text-text-muted-dark" />
                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark leading-relaxed">
                        {t('closeNote')}
                    </p>
                </div>
            </div>
        </div>
    );
}
