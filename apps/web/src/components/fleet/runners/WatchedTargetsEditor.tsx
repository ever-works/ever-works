'use client';

import { useEffect, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import {
    FLEET_ACTIONS_MAX_WATCHED_TARGETS,
    type FleetActionsWatchedTarget,
    type FleetLinkError,
} from '@ever-works/contracts';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { setFleetActionsWatchedTargetsAction } from '@/app/actions/fleet/runners';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    addWatchedTarget,
    removeWatchedTarget,
    targetKey,
    watchableTargets,
} from './runners.shared';

const FIELD =
    'h-8 w-full rounded-md border border-border dark:border-border-dark bg-surface dark:bg-surface-dark px-2 text-sm';

/**
 * Actions jobs (FL-18 P2, spec §5.4, FR-21) — **Change** on the Actions jobs
 * panel: the watched repositories and organisations, each with a remove
 * button; add one from those the owner's GitHub App covers (`available`, at
 * most {@link FLEET_ACTIONS_MAX_WATCHED_TARGETS}); **Save** writes the list,
 * **Use the default** clears it (the panel then watches every target the
 * owner's runners are registered for). The server normalises and decides.
 */
export function WatchedTargetsEditor({
    open,
    watched,
    saved,
    available,
    onClose,
    onSaved,
}: {
    open: boolean;
    /** What the panel watches now. */
    watched: readonly FleetActionsWatchedTarget[];
    /** True when `watched` is a saved list (false: the default). */
    saved: boolean;
    /** Every target the owner's GitHub App covers. */
    available: readonly FleetActionsWatchedTarget[];
    onClose: () => void;
    onSaved: (watched: FleetActionsWatchedTarget[]) => void;
}) {
    const t = useTranslations('fleet.runners.jobs.watched');
    const [list, setList] = useState<FleetActionsWatchedTarget[]>([...watched]);
    const [adding, setAdding] = useState('');
    const [error, setError] = useState<FleetLinkError | null>(null);
    const [pending, startTransition] = useTransition();

    // The list as the panel watches it, each time the editor opens.
    useEffect(() => {
        if (!open) return;
        setList([...watched]);
        setAdding('');
        setError(null);
        // `watched` is read at opening only: the panel's 30 s refresh must not undo edits.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const addable = watchableTargets(available, list);
    const full = list.length >= FLEET_ACTIONS_MAX_WATCHED_TARGETS;
    const chosen = addable.find((entry) => targetKey(entry) === adding) ?? null;
    const scopeLabel = (entry: FleetActionsWatchedTarget) =>
        entry.scope === 'org' ? t('organisation') : t('repository');

    const save = (targets: FleetActionsWatchedTarget[]) => {
        setError(null);
        startTransition(async () => {
            const result = await setFleetActionsWatchedTargetsAction(targets);
            if (result.ok) {
                toast.success(t('saved'));
                onSaved(result.data.watched);
                onClose();
                return;
            }
            setError(result.error);
        });
    };

    return (
        <Dialog open={open} onOpenChange={(next) => (!next ? onClose() : undefined)}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>
                <div
                    className="flex flex-col gap-3 text-sm"
                    data-testid="fleet-actions-watched-editor"
                >
                    {!saved ? (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('defaultNote')}
                        </p>
                    ) : null}
                    {list.length === 0 ? (
                        <p className="text-text-muted dark:text-text-muted-dark">{t('empty')}</p>
                    ) : (
                        <ul
                            className="flex flex-col gap-1"
                            data-testid="fleet-actions-watched-list"
                        >
                            {list.map((entry) => (
                                <li key={targetKey(entry)} className="flex items-center gap-2">
                                    <span className="font-medium">{entry.target}</span>
                                    <span className="text-xs text-text-muted dark:text-text-muted-dark">
                                        {scopeLabel(entry)}
                                    </span>
                                    <button
                                        type="button"
                                        className="ml-auto rounded p-1 hover:bg-surface-hover dark:hover:bg-surface-hover-dark"
                                        onClick={() =>
                                            setList((previous) =>
                                                removeWatchedTarget(previous, entry),
                                            )
                                        }
                                        aria-label={t('remove', { target: entry.target })}
                                    >
                                        <X className="h-4 w-4" aria-hidden />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    {available.length === 0 ? (
                        <div className="flex flex-col gap-1 text-xs">
                            <p>{t('noneAvailable')}</p>
                            <Link
                                href={ROUTES.DASHBOARD_SETTINGS_GITHUB_APP}
                                className="text-primary underline"
                            >
                                {t('openAppSettings')}
                            </Link>
                        </div>
                    ) : (
                        <div className="flex items-end gap-2">
                            <label className="flex flex-1 flex-col gap-1">
                                <span className="font-medium">{t('addLabel')}</span>
                                <select
                                    className={FIELD}
                                    value={adding}
                                    onChange={(event) => setAdding(event.target.value)}
                                    disabled={full || addable.length === 0}
                                    data-testid="fleet-actions-watched-add-select"
                                >
                                    <option value="">{t('choose')}</option>
                                    {addable.map((entry) => (
                                        <option key={targetKey(entry)} value={targetKey(entry)}>
                                            {`${entry.target} (${scopeLabel(entry)})`}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <Button
                                type="button"
                                size="sm"
                                variant="secondary"
                                disabled={!chosen || full}
                                onClick={() => {
                                    if (!chosen) return;
                                    setList((previous) => addWatchedTarget(previous, chosen));
                                    setAdding('');
                                }}
                                data-testid="fleet-actions-watched-add"
                            >
                                {t('add')}
                            </Button>
                        </div>
                    )}
                    {full ? (
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('limit', { max: FLEET_ACTIONS_MAX_WATCHED_TARGETS })}
                        </p>
                    ) : null}
                    {error ? (
                        <p className="text-sm text-danger" role="alert">
                            {error.hint || t('failed')}
                        </p>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button type="button" variant="ghost" onClick={onClose}>
                        {t('cancel')}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={() => save([])}
                        disabled={pending}
                        data-testid="fleet-actions-watched-default"
                    >
                        {t('useDefault')}
                    </Button>
                    <Button
                        type="button"
                        onClick={() => save(list)}
                        loading={pending}
                        data-testid="fleet-actions-watched-save"
                    >
                        {t('save')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
