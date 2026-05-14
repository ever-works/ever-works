'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { useSettings } from './SettingsContext';
import { rotateActivitySyncSecret, updateActivitySyncMode } from '@/app/actions/dashboard/works';
import { useRouter } from '@/i18n/navigation';
import { toast } from 'sonner';

type Mode = 'pull' | 'push' | 'disabled';
const MODES: readonly Mode[] = ['pull', 'push', 'disabled'];

/**
 * EW-120 dual-mode Activity Feed sync settings.
 *
 * Renders a 3-mode radio + per-mode explainer, plus (for pull mode only) a
 * "Rotate sync secret" button with a redeploy-required warning. The mode
 * field is also writable via `works.yml` (`activity_sync.mode`); this UI is
 * the convenience path. Both routes converge on `Work.activitySyncMode`.
 */
export function ActivitySyncSettings() {
    const t = useTranslations('dashboard.workDetail.settings.activitySync');
    const router = useRouter();
    const { context } = useSettings();
    const { work } = context;
    const currentMode = (work.activitySyncMode ?? 'pull') as Mode;
    const [pending, startTransition] = useTransition();
    const [rotating, setRotating] = useState(false);

    const handleModeChange = (next: Mode) => {
        if (next === currentMode) return;
        startTransition(async () => {
            const result = await updateActivitySyncMode(work.id, next);
            if (result.success) {
                toast.success(t('modeUpdated', { mode: t(`modes.${next}.label`) }));
                router.refresh();
            } else {
                toast.error(result.error || t('modeUpdateFailed'));
            }
        });
    };

    const handleRotate = async () => {
        if (!confirm(t('rotateConfirm'))) return;
        setRotating(true);
        try {
            const result = await rotateActivitySyncSecret(work.id);
            if (result.success) {
                toast.success(t('rotateSuccess'));
                router.refresh();
            } else {
                toast.error(result.error || t('rotateFailed'));
            }
        } finally {
            setRotating(false);
        }
    };

    const lastSuccess = work.platformSyncLastSuccessAt
        ? formatDistanceToNow(new Date(work.platformSyncLastSuccessAt), { addSuffix: true })
        : null;
    const lastError = work.platformSyncLastErrorMessage ?? null;

    return (
        <div
            className={cn(
                'rounded-lg border overflow-hidden',
                'bg-card dark:bg-card-primary-dark/30',
                'border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div className="px-5 py-3.5 border-b border-card-border dark:border-border-secondary-dark">
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                    {t('subtitle')}
                </p>
            </div>

            <div className="px-5 py-4 space-y-4">
                <fieldset className="space-y-3" disabled={pending}>
                    <legend className="sr-only">{t('modeLegend')}</legend>
                    {MODES.map((mode) => (
                        <label
                            key={mode}
                            className={cn(
                                'flex items-start gap-3 rounded-md border p-3 cursor-pointer transition-colors',
                                'border-border dark:border-border-dark',
                                'hover:bg-muted/30 dark:hover:bg-muted/10',
                                currentMode === mode &&
                                    'border-primary/60 bg-primary/5 dark:bg-primary/10',
                                pending && 'opacity-60 cursor-not-allowed',
                            )}
                        >
                            <input
                                type="radio"
                                name="activitySyncMode"
                                value={mode}
                                checked={currentMode === mode}
                                onChange={() => handleModeChange(mode)}
                                disabled={pending}
                                className="mt-0.5"
                            />
                            <div className="flex-1 min-w-0">
                                <div className="text-xs font-medium text-text dark:text-text-dark">
                                    {t(`modes.${mode}.label`)}
                                    {mode === 'pull' && (
                                        <span className="ml-2 text-[10px] uppercase tracking-wider text-text-muted">
                                            {t('defaultBadge')}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                                    {t(`modes.${mode}.description`)}
                                </p>
                            </div>
                            {pending && currentMode !== mode && (
                                <Loader2 className="h-4 w-4 animate-spin text-text-muted" />
                            )}
                        </label>
                    ))}
                </fieldset>

                {currentMode === 'pull' && (
                    <div className="pt-3 border-t border-card-border dark:border-border-secondary-dark space-y-3">
                        <div>
                            <h4 className="text-xs font-medium text-text dark:text-text-dark">
                                {t('rotate.label')}
                            </h4>
                            <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                                {t('rotate.description')}
                            </p>
                            <button
                                type="button"
                                onClick={handleRotate}
                                disabled={rotating || pending}
                                className={cn(
                                    'mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium',
                                    'border border-warning/40 bg-warning/10 text-warning',
                                    'hover:bg-warning/15 transition-colors',
                                    (rotating || pending) && 'opacity-60 cursor-not-allowed',
                                )}
                            >
                                {rotating && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                                {t('rotate.action')}
                            </button>
                        </div>

                        {(lastSuccess || lastError) && (
                            <div className="text-xs text-text-muted dark:text-text-muted-dark space-y-1">
                                {lastSuccess && (
                                    <div>{t('status.lastSuccess', { time: lastSuccess })}</div>
                                )}
                                {lastError && (
                                    <div className="text-error">
                                        {t('status.lastError', { error: lastError })}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
