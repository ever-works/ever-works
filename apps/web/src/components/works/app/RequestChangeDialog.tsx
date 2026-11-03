'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { GitPullRequestArrow } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { ROUTES } from '@/lib/constants';
import { requestAppChangeAction } from '@/app/actions/dashboard/app-changes';

/** The longest request the API accepts (`EvolveWorkDto.request`). */
export const APP_CHANGE_REQUEST_MAX = 4000;

/** The refusal copy the dialog has, one key per `dashboard.workDetail.appChange.errors` leaf. */
export type AppChangeErrorKey =
    | 'agentRequired'
    | 'switchOff'
    | 'appSpecMissing'
    | 'agentNotEligible'
    | 'notAppWork'
    | 'invalid'
    | 'generic';

const KNOWN_ERRORS: ReadonlySet<string> = new Set<AppChangeErrorKey>([
    'agentRequired',
    'switchOff',
    'appSpecMissing',
    'agentNotEligible',
    'notAppWork',
    'invalid',
]);

/** Which copy a refusal gets: the API's own code when the dialog knows it. */
export function appChangeErrorKey(code: string | undefined): AppChangeErrorKey {
    if (code === 'invalid_request' || code === 'invalidRequest') return 'invalid';
    return code && KNOWN_ERRORS.has(code) ? (code as AppChangeErrorKey) : 'generic';
}

type Outcome =
    | {
          kind: 'filed';
          taskId: string;
          taskSlug: string;
          awaitingOwner: boolean;
          cloudPushOff: boolean;
      }
    | { kind: 'refused'; errorKey: AppChangeErrorKey };

/**
 * APW-08 T27 (`RequestChangeDialog`) — **Request a change** on the App Work overview: one text
 * field, `POST /api/works/:id/evolve` through a server action, then the Task it filed (or why it
 * was refused, by the API's own code). The Agent is resolved by the platform's rule (APW-08 T25);
 * a member's request is held for the owner, and the operator's change switch answers `switchOff`.
 */
export function RequestChangeDialog({ workId }: { workId: string }) {
    const t = useTranslations('dashboard.workDetail.appChange');
    const [open, setOpen] = useState(false);
    const [text, setText] = useState('');
    const [pending, setPending] = useState(false);
    const [outcome, setOutcome] = useState<Outcome | null>(null);

    const trimmed = text.trim();
    const canSubmit = trimmed.length > 0 && trimmed.length <= APP_CHANGE_REQUEST_MAX && !pending;

    const close = () => {
        setOpen(false);
        setOutcome(null);
        if (outcome?.kind === 'filed') setText('');
    };

    const submit = async () => {
        if (!canSubmit) return;
        setPending(true);
        try {
            const result = await requestAppChangeAction(workId, trimmed);
            if (result.success && result.data) {
                setOutcome({
                    kind: 'filed',
                    taskId: result.data.taskId,
                    taskSlug: result.data.taskSlug,
                    awaitingOwner: result.data.awaitingOwner === true,
                    cloudPushOff: (result.data.warnings ?? []).includes('cloudPushOff'),
                });
            } else {
                setOutcome({ kind: 'refused', errorKey: appChangeErrorKey(result.code) });
            }
        } finally {
            setPending(false);
        }
    };

    return (
        <>
            <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => setOpen(true)}
                data-testid="app-change-open"
            >
                <GitPullRequestArrow className="h-3.5 w-3.5" aria-hidden="true" />
                {t('button')}
            </Button>

            {open && (
                <Dialog open onOpenChange={(next) => (next ? undefined : close())}>
                    <DialogContent className="max-w-lg">
                        <DialogClose onClose={close} />
                        <div className="space-y-4" data-testid="app-change-dialog">
                            <DialogHeader>
                                <DialogTitle className="text-lg font-semibold text-text dark:text-text-dark">
                                    {t('title')}
                                </DialogTitle>
                                <DialogDescription className="text-sm text-text-secondary dark:text-text-secondary-dark">
                                    {t('description')}
                                </DialogDescription>
                            </DialogHeader>

                            {outcome?.kind === 'filed' ? (
                                <div
                                    role="status"
                                    className="space-y-2 text-sm text-text dark:text-text-dark"
                                    data-testid="app-change-filed"
                                >
                                    <p>{t('filed', { slug: outcome.taskSlug })}</p>
                                    {outcome.awaitingOwner && (
                                        <p className="text-text-secondary dark:text-text-secondary-dark">
                                            {t('awaitingOwner')}
                                        </p>
                                    )}
                                    {outcome.cloudPushOff && (
                                        <p className="text-text-secondary dark:text-text-secondary-dark">
                                            {t('cloudPushOff')}
                                        </p>
                                    )}
                                    <Link
                                        href={ROUTES.DASHBOARD_TASK(outcome.taskId)}
                                        className="font-medium text-primary hover:underline dark:text-primary-dark"
                                        data-testid="app-change-task-link"
                                    >
                                        {t('openTask')}
                                    </Link>
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    <label
                                        htmlFor={`app-change-request-${workId}`}
                                        className="text-sm font-medium text-text dark:text-text-dark"
                                    >
                                        {t('label')}
                                    </label>
                                    <Textarea
                                        id={`app-change-request-${workId}`}
                                        value={text}
                                        onChange={(event) => setText(event.target.value)}
                                        placeholder={t('placeholder')}
                                        maxLength={APP_CHANGE_REQUEST_MAX}
                                        rows={5}
                                        disabled={pending}
                                        data-testid="app-change-text"
                                    />
                                    {/* APW-08 T52 — secondary, not muted: the muted token is 2.45:1 on
                                        the dialog surface (WCAG AA wants 4.5:1 for 12px text). */}
                                    <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                                        {t('counter', {
                                            count: trimmed.length,
                                            max: APP_CHANGE_REQUEST_MAX,
                                        })}
                                    </p>
                                    {outcome?.kind === 'refused' && (
                                        <p
                                            role="alert"
                                            className="text-sm text-red-600 dark:text-red-400"
                                            data-testid="app-change-error"
                                            data-code={outcome.errorKey}
                                        >
                                            {t(`errors.${outcome.errorKey}`)}
                                        </p>
                                    )}
                                </div>
                            )}

                            <DialogFooter>
                                {outcome?.kind === 'filed' ? (
                                    <Button type="button" onClick={close}>
                                        {t('close')}
                                    </Button>
                                ) : (
                                    <>
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            onClick={close}
                                            disabled={pending}
                                        >
                                            {t('cancel')}
                                        </Button>
                                        <Button
                                            type="button"
                                            onClick={() => void submit()}
                                            disabled={!canSubmit}
                                            loading={pending}
                                            data-testid="app-change-submit"
                                        >
                                            {t('submit')}
                                        </Button>
                                    </>
                                )}
                            </DialogFooter>
                        </div>
                    </DialogContent>
                </Dialog>
            )}
        </>
    );
}
