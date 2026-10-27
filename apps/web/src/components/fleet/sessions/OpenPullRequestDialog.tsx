'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    FLEET_PULL_REQUEST_BODY_MAX_LENGTH,
    FLEET_PULL_REQUEST_TITLE_MAX_LENGTH,
    type FleetPullRequestDraft,
} from '@ever-works/contracts';
import {
    getPullRequestDraftAction,
    openCheckoutPullRequestAction,
} from '@/app/actions/fleet-session-git';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { sessionGitErrorTitleKey } from './session-git.shared';

/**
 * Session git & actions (FL-06, spec FR-16 … FR-18, S5, U10, U12, §5.4) —
 * the owner session's pull-request dialog: title (≤ 70 characters,
 * prefilled), body, the base (read-only) and **Draft**. The platform opens it
 * through the GitHub App — the session is never asked to use a GitHub
 * credential of its own — or, when one is already open for the branch,
 * updates its title and body ("Update the pull request #912").
 */
export function OpenPullRequestDialog({
    open,
    onOpenChange,
    checkoutId,
    sessionId,
    onOpened,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    checkoutId: string;
    sessionId: string;
    onOpened: (pr: { number: number; url: string; updated: boolean }) => void;
}) {
    const t = useTranslations('fleet.sessionGit.pullRequestDialog');
    const tErrors = useTranslations('fleet.sessionGit.errorTitles');
    const [draft, setDraft] = useState<FleetPullRequestDraft | null>(null);
    const [title, setTitle] = useState('');
    const [body, setBody] = useState('');
    const [isDraft, setIsDraft] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setError(null);
        let cancelled = false;
        void getPullRequestDraftAction(checkoutId).then((result) => {
            if (cancelled) return;
            if (!result.success) {
                setError(
                    `${tErrors(sessionGitErrorTitleKey(result.code))}${result.hint ? ` — ${result.hint}` : ''}`,
                );
                return;
            }
            setDraft(result.data);
            setTitle((current) => current || result.data.title);
            setBody((current) => current || result.data.body);
        });
        return () => {
            cancelled = true;
        };
    }, [open, checkoutId, tErrors]);

    const existing =
        draft?.existing && (draft.existing.state === 'open' || draft.existing.state === 'draft')
            ? draft.existing
            : null;
    const submit = async () => {
        if (pending || !title.trim()) return;
        setPending(true);
        setError(null);
        const result = await openCheckoutPullRequestAction(checkoutId, {
            title: title.trim(),
            ...(body.trim() ? { body } : {}),
            ...(isDraft ? { draft: true } : {}),
            sessionId,
        });
        setPending(false);
        if (!result.success) {
            setError(
                `${tErrors(sessionGitErrorTitleKey(result.code))}${result.hint ? ` — ${result.hint}` : ''}`,
            );
            return;
        }
        toast.success(
            result.data.updated
                ? t('updated', { number: result.data.number })
                : t('opened', { number: result.data.number }),
        );
        onOpened({
            number: result.data.number,
            url: result.data.url,
            updated: result.data.updated,
        });
        onOpenChange(false);
    };

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="max-w-xl">
                <div data-testid="fleet-pull-request-dialog">
                    <DialogHeader>
                        <DialogTitle className="text-base font-semibold text-text dark:text-text-dark">
                            {existing
                                ? t('titleUpdate', { number: existing.number })
                                : t('titleOpen')}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3">
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('branchLine', {
                                branch: draft?.branch ?? '—',
                                base: draft?.base ?? '—',
                            })}
                        </p>
                        {draft && !draft.pushed ? (
                            <p className="text-xs text-warning" role="status">
                                {t('notPushed')}
                            </p>
                        ) : null}
                        <label className="block space-y-1 text-sm">
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {t('titleLabel')}
                            </span>
                            <input
                                value={title}
                                onChange={(event) => setTitle(event.target.value)}
                                maxLength={FLEET_PULL_REQUEST_TITLE_MAX_LENGTH}
                                className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm"
                                data-testid="fleet-pull-request-title"
                            />
                        </label>
                        <label className="block space-y-1 text-sm">
                            <span className="text-text-muted dark:text-text-muted-dark">
                                {t('bodyLabel')}
                            </span>
                            <textarea
                                value={body}
                                onChange={(event) => setBody(event.target.value)}
                                maxLength={FLEET_PULL_REQUEST_BODY_MAX_LENGTH}
                                rows={6}
                                className="w-full rounded-md border border-border dark:border-border-dark bg-transparent px-3 py-2 text-sm"
                                data-testid="fleet-pull-request-body"
                            />
                        </label>
                        {!existing ? (
                            <label className="flex items-center gap-2 text-sm">
                                <input
                                    type="checkbox"
                                    checked={isDraft}
                                    onChange={(event) => setIsDraft(event.target.checked)}
                                    data-testid="fleet-pull-request-draft"
                                />
                                <span>{t('draft')}</span>
                            </label>
                        ) : null}
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            {t('byPlatform')}
                        </p>
                        {error ? (
                            <p
                                role="alert"
                                className="text-sm text-danger"
                                data-testid="fleet-pull-request-error"
                            >
                                {error}
                            </p>
                        ) : null}
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={() => onOpenChange(false)}
                            disabled={pending}
                        >
                            {t('cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={() => void submit()}
                            disabled={pending || !title.trim()}
                            data-testid="fleet-pull-request-submit"
                        >
                            {pending
                                ? t('working')
                                : existing
                                  ? t('submitUpdate')
                                  : t('submitOpen')}
                        </Button>
                    </DialogFooter>
                </div>
            </DialogContent>
        </Dialog>
    );
}
