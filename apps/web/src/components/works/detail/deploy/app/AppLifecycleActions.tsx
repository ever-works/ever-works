'use client';

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { History, Pause, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { appLifecycleAction, rollbackAppAction } from '@/app/actions/dashboard/app-runtime';
import {
    rollbackCandidates,
    type AppLifecycleActionChoice,
    type AppStatusView,
} from '@/lib/api/app-runtime.types';

export interface AppLifecycleActionsProps {
    work: { id: string; slug: string };
    status: AppStatusView;
    /** Called after the API accepted an action, so the page can re-read the status. */
    onChanged?: () => void;
}

/**
 * Lane aw-deploy-3 — the Deploy tab's **Roll back**, **Pause / Resume** and **Remove** (spec
 * §6.1 S4–S6, T63's live / failed / rollback / remove states).
 *
 * - **Roll back** opens a dialog listing the earlier Live Deployments (`app-status.ops`), with
 *   "run the pre-deploy jobs again" off by default (FR-34), and calls `POST app-rollback`.
 * - **Pause** / **Resume** follow the runtime state and call `POST app-lifecycle`.
 * - **Remove** opens a dialog; deleting stored data too requires typing the App Work's slug, and
 *   the button stays disabled until it matches (the API checks it again: `CONFIRM_SLUG_MISMATCH`).
 *
 * Every action is single-flight and answers with a toast or an inline message — never silently.
 */
export function AppLifecycleActions({ work, status, onChanged }: AppLifecycleActionsProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.lifecycle');
    const tRollback = useTranslations('dashboard.workDetail.appDeploy.rollback');
    const inFlight = useRef(false);
    const [pending, setPending] = useState<AppLifecycleActionChoice | 'rollback' | null>(null);
    const [rollbackOpen, setRollbackOpen] = useState(false);
    const [removeOpen, setRemoveOpen] = useState(false);

    const candidates = rollbackCandidates(status);
    const deployed = status.state !== 'not-deployed' && status.state !== 'deleting';
    const paused = status.state === 'paused';

    const lifecycle = async (
        action: AppLifecycleActionChoice,
        extra: { deleteData?: boolean; confirmSlug?: string } = {},
    ): Promise<boolean> => {
        if (inFlight.current) return false;
        inFlight.current = true;
        setPending(action);
        try {
            const result = await appLifecycleAction(work.id, { action, ...extra });
            if (result.success) {
                toast.success(
                    t(`accepted.${action === 'cancel-deploy' ? 'cancelDeploy' : action}`),
                );
                onChanged?.();
                return true;
            }
            toast.error(
                result.code === 'CONFIRM_SLUG_MISMATCH'
                    ? t('slugMismatch')
                    : t('failed', { reason: result.error ?? result.code ?? '' }),
            );
            return false;
        } catch {
            toast.error(t('failed', { reason: '' }));
            return false;
        } finally {
            inFlight.current = false;
            setPending(null);
        }
    };

    return (
        <div className="flex flex-wrap gap-2" data-testid="app-lifecycle-actions">
            {deployed && (
                <Button
                    type="button"
                    variant="secondary"
                    className="gap-1.5"
                    onClick={() => setRollbackOpen(true)}
                    disabled={pending !== null}
                    data-testid="app-rollback-open"
                >
                    <History className="h-4 w-4" aria-hidden="true" />
                    {tRollback('button')}
                </Button>
            )}
            {deployed && !paused && (
                <Button
                    type="button"
                    variant="secondary"
                    className="gap-1.5"
                    onClick={() => void lifecycle('pause')}
                    loading={pending === 'pause'}
                    disabled={pending !== null}
                    data-testid="app-lifecycle-pause"
                >
                    <Pause className="h-4 w-4" aria-hidden="true" />
                    {t('pause')}
                </Button>
            )}
            {paused && (
                <Button
                    type="button"
                    variant="secondary"
                    className="gap-1.5"
                    onClick={() => void lifecycle('resume')}
                    loading={pending === 'resume'}
                    disabled={pending !== null}
                    data-testid="app-lifecycle-resume"
                >
                    <Play className="h-4 w-4" aria-hidden="true" />
                    {t('resume')}
                </Button>
            )}
            {deployed && (
                <Button
                    type="button"
                    variant="danger"
                    className="gap-1.5"
                    onClick={() => setRemoveOpen(true)}
                    disabled={pending !== null}
                    data-testid="app-lifecycle-remove-open"
                >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                    {t('remove')}
                </Button>
            )}

            {rollbackOpen && (
                <AppRollbackDialog
                    workId={work.id}
                    candidates={candidates}
                    onOpenChange={setRollbackOpen}
                    onRequested={() => onChanged?.()}
                />
            )}
            {removeOpen && (
                <AppRemoveDialog
                    slug={work.slug}
                    pending={pending === 'remove'}
                    onOpenChange={setRemoveOpen}
                    onConfirm={async (deleteData, confirmSlug) => {
                        const accepted = await lifecycle('remove', {
                            deleteData,
                            ...(deleteData ? { confirmSlug } : {}),
                        });
                        if (accepted) setRemoveOpen(false);
                    }}
                />
            )}
        </div>
    );
}

interface AppRollbackDialogProps {
    workId: string;
    candidates: ReturnType<typeof rollbackCandidates>;
    onOpenChange: (open: boolean) => void;
    onRequested: () => void;
}

function AppRollbackDialog({
    workId,
    candidates,
    onOpenChange,
    onRequested,
}: AppRollbackDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.rollback');
    const groupId = useId();
    const jobsId = useId();
    const [selected, setSelected] = useState<string>(candidates[0]?.deploymentId ?? '');
    const [runJobs, setRunJobs] = useState(false);
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    const submit = async () => {
        if (!selected || pending) return;
        setPending(true);
        setMessage(null);
        try {
            const result = await rollbackAppAction(workId, {
                deploymentId: selected,
                ...(runJobs ? { runPreDeployJobs: true } : {}),
            });
            if (result.success) {
                toast.success(t('started'));
                onRequested();
                onOpenChange(false);
                return;
            }
            const unmet = result.data?.unmet?.length ? result.data.unmet : (result.unmet ?? []);
            setMessage(
                unmet.length > 0
                    ? unmet.map((entry) => entry.message || entry.code).join(' ')
                    : t('failed', { reason: result.error ?? result.code ?? '' }),
            );
        } catch {
            setMessage(t('failed', { reason: '' }));
        } finally {
            setPending(false);
        }
    };

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogClose onClose={() => onOpenChange(false)} />
                <div className="space-y-4" data-testid="app-rollback-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('title')}
                        </DialogTitle>
                        <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('description')}
                        </DialogDescription>
                    </DialogHeader>

                    {candidates.length === 0 ? (
                        <p className="text-sm text-text-secondary" data-testid="app-rollback-none">
                            {t('none')}
                        </p>
                    ) : (
                        <fieldset className="space-y-2" aria-labelledby={groupId}>
                            <legend id={groupId} className="text-sm font-medium">
                                {t('pickLabel')}
                            </legend>
                            {candidates.map((op) => (
                                <label
                                    key={op.deploymentId}
                                    className="flex items-center gap-2 text-sm"
                                    data-testid="app-rollback-candidate"
                                >
                                    <input
                                        type="radio"
                                        name={groupId}
                                        value={op.deploymentId}
                                        checked={selected === op.deploymentId}
                                        onChange={() => setSelected(op.deploymentId ?? '')}
                                    />
                                    <span className="font-mono">
                                        {(op.deploymentId ?? '').slice(0, 8)}
                                    </span>
                                    <span className="text-text-secondary">
                                        {op.at
                                            ? t('liveAt', { when: new Date(op.at) })
                                            : t('liveAtUnknown')}
                                    </span>
                                </label>
                            ))}
                        </fieldset>
                    )}

                    {candidates.length > 0 && (
                        <label htmlFor={jobsId} className="flex items-start gap-2 text-sm">
                            <input
                                id={jobsId}
                                type="checkbox"
                                checked={runJobs}
                                onChange={(event) => setRunJobs(event.target.checked)}
                            />
                            {t('runJobs')}
                        </label>
                    )}

                    {message && (
                        <p
                            role="alert"
                            className="text-sm text-danger"
                            data-testid="app-rollback-message"
                        >
                            {message}
                        </p>
                    )}

                    <DialogFooter className="gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            onClick={submit}
                            loading={pending}
                            disabled={!selected || pending}
                            data-testid="app-rollback-confirm"
                        >
                            {t('confirm')}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}

interface AppRemoveDialogProps {
    slug: string;
    pending: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (deleteData: boolean, confirmSlug: string) => Promise<void>;
}

function AppRemoveDialog({ slug, pending, onOpenChange, onConfirm }: AppRemoveDialogProps) {
    const t = useTranslations('dashboard.workDetail.appDeploy.lifecycle');
    const dataId = useId();
    const slugId = useId();
    const [deleteData, setDeleteData] = useState(false);
    const [typed, setTyped] = useState('');
    const slugMatches = typed.trim() === slug;
    const canConfirm = !pending && (!deleteData || slugMatches);

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogClose onClose={() => onOpenChange(false)} />
                <div className="space-y-4" data-testid="app-remove-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                            {t('removeTitle')}
                        </DialogTitle>
                        <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                            {t('removeDescription')}
                        </DialogDescription>
                    </DialogHeader>

                    <label htmlFor={dataId} className="flex items-start gap-2 text-sm">
                        <input
                            id={dataId}
                            type="checkbox"
                            checked={deleteData}
                            onChange={(event) => setDeleteData(event.target.checked)}
                            data-testid="app-remove-delete-data"
                        />
                        <span>
                            {t('deleteData')}
                            <span className="block text-danger">{t('deleteDataWarning')}</span>
                        </span>
                    </label>

                    {deleteData && (
                        <div className="space-y-1">
                            <label htmlFor={slugId} className="text-sm font-medium">
                                {t('confirmSlugLabel', { slug })}
                            </label>
                            <Input
                                id={slugId}
                                value={typed}
                                onChange={(event) => setTyped(event.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                data-testid="app-remove-confirm-slug"
                            />
                        </div>
                    )}

                    <DialogFooter className="gap-2">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="danger"
                            onClick={() => void onConfirm(deleteData, typed.trim())}
                            loading={pending}
                            disabled={!canConfirm}
                            data-testid="app-remove-confirm"
                        >
                            {t('confirmRemove')}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
