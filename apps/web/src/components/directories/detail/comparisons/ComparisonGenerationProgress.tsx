'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils/cn';

const STAGES = ['researching', 'analyzing', 'writing', 'writing_extended', 'saving'] as const;

type Stage = (typeof STAGES)[number];

interface ComparisonGenerationProgressProps {
    directoryId: string;
    isGenerating: boolean;
}

export function ComparisonGenerationProgress({
    directoryId,
    isGenerating,
}: ComparisonGenerationProgressProps) {
    const t = useTranslations('dashboard.directoryDetail.comparisons');
    const [status, setStatus] = useState<{
        generating: boolean;
        stage?: string;
        itemAName?: string;
        itemBName?: string;
    }>({ generating: false });
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        if (!isGenerating) {
            setStatus({ generating: false });
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
            return;
        }

        const poll = async () => {
            try {
                // Use direct fetch to Route Handler instead of server action
                // to avoid Next.js server action serialization (which would
                // block this call while the generation server action is running)
                const res = await fetch(
                    `/api/directories/${directoryId}/comparisons/generation-status`,
                );
                if (res.ok) {
                    setStatus(await res.json());
                }
            } catch {
                // Silently ignore polling errors
            }
        };

        // Poll immediately, then every 1.5s
        poll();
        intervalRef.current = setInterval(poll, 1500);

        return () => {
            if (intervalRef.current) {
                clearInterval(intervalRef.current);
                intervalRef.current = null;
            }
        };
    }, [isGenerating, directoryId]);

    if (!isGenerating) return null;

    const currentStage = status.stage as Stage | undefined;
    const currentStageIndex = currentStage ? STAGES.indexOf(currentStage) : -1;

    // Only show stages up to writing_extended if it's active; otherwise hide it
    // Keep writing_extended visible once it has started or completed,
    // so the progress bar doesn't shrink when transitioning to saving
    const visibleStages = STAGES.filter(
        (s) => s !== 'writing_extended' || currentStageIndex >= STAGES.indexOf('writing_extended'),
    );

    return (
        <div className="rounded-lg border border-border dark:border-border-dark p-4 space-y-3">
            <div className="flex items-center gap-3">
                <div className="relative h-4 w-4 shrink-0">
                    <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping" />
                    <div className="absolute inset-0.5 rounded-full bg-primary" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-medium text-text dark:text-text-dark truncate">
                        {currentStage && status.itemAName && status.itemBName
                            ? t(`progress.stages.${currentStage}`, {
                                  itemA: status.itemAName,
                                  itemB: status.itemBName,
                              })
                            : t('actions.generating')}
                    </p>
                    {status.itemAName && status.itemBName && (
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {status.itemAName} vs {status.itemBName}
                        </p>
                    )}
                </div>
            </div>

            {/* Step indicators */}
            {currentStageIndex >= 0 && (
                <div className="flex items-center gap-1.5">
                    {visibleStages.map((stage) => {
                        const stageIndex = STAGES.indexOf(stage);
                        const isCompleted = stageIndex < currentStageIndex;
                        const isCurrent = stageIndex === currentStageIndex;

                        return (
                            <div key={stage} className="flex items-center gap-1.5 flex-1">
                                <div
                                    className={cn(
                                        'h-1.5 rounded-full flex-1 transition-all duration-500',
                                        isCompleted && 'bg-primary',
                                        isCurrent && 'bg-primary/60 animate-pulse',
                                        !isCompleted &&
                                            !isCurrent &&
                                            'bg-surface-hover dark:bg-surface-hover-dark',
                                    )}
                                />
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
