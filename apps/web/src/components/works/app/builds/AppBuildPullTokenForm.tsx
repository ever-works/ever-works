'use client';

import { useState, type FormEvent } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { setAppBuildPullTokenAction } from '@/app/actions/dashboard/app-builds';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import type { AppBuildsPullAccess } from '@/lib/works/app-builds.shared';

/**
 * APW-05 T28 — the image pull token (spec §6.5, plan §4.12, `APW05-G07`).
 *
 * **Write-only.** The token is typed, sent once through
 * `PUT /api/works/:id/builds/pull-token`, and the field is cleared after every
 * answer — success or refusal — so it is never re-populated and never held in
 * state longer than one request. Nothing here can read a stored token back:
 * the API only ever answers `{ pullAccess: { visibility, tokenSet,
 * tokenExpiresAt } }`.
 */
export interface AppBuildPullTokenFormProps {
    workId: string;
    canEdit: boolean;
    pullAccess: AppBuildsPullAccess | null;
    /** For the `pullTokenCannotRead` copy. */
    imageRepository?: string | null;
}

type PullTokenRefusalKey = 'tooBroad' | 'fineGrained' | 'cannotRead' | 'publicImage' | 'noImageYet';

const REFUSAL_KEYS: Record<string, PullTokenRefusalKey> = {
    pullTokenTooBroad: 'tooBroad',
    pullTokenFineGrained: 'fineGrained',
    pullTokenCannotRead: 'cannotRead',
    pullTokenPublicImage: 'publicImage',
    pullTokenNoImageYet: 'noImageYet',
};

export function AppBuildPullTokenForm({
    workId,
    canEdit,
    pullAccess: initialPullAccess,
    imageRepository,
}: AppBuildPullTokenFormProps) {
    const t = useTranslations('dashboard.workDetail.builds.pullToken');
    const format = useFormatter();
    const [token, setToken] = useState('');
    const [pending, setPending] = useState(false);
    const [pullAccess, setPullAccess] = useState<AppBuildsPullAccess | null>(initialPullAccess);
    const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

    const formatDate = (iso: string) => {
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? iso : format.dateTime(date, { dateStyle: 'medium' });
    };

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!canEdit || pending || token.trim().length === 0) return;
        const value = token;
        // Cleared before the request resolves: the value never outlives the click.
        setToken('');
        setPending(true);
        setMessage(null);
        try {
            const result = await setAppBuildPullTokenAction(workId, value);
            if (result.success) {
                const next = result.data?.pullAccess ?? null;
                setPullAccess(next);
                setMessage({
                    tone: 'ok',
                    text: next?.tokenExpiresAt
                        ? t('savedExpires', { date: formatDate(next.tokenExpiresAt) })
                        : t('savedNoExpiry'),
                });
                return;
            }
            if (result.statusCode === 403) {
                setMessage({ tone: 'error', text: t('viewerDisabled') });
                return;
            }
            const key = result.code ? REFUSAL_KEYS[result.code] : undefined;
            setMessage({
                tone: 'error',
                text: key ? t(key, { imageRepository: imageRepository ?? '—' }) : t('failed'),
            });
        } catch {
            setMessage({ tone: 'error', text: t('failed') });
        } finally {
            setPending(false);
        }
    };

    return (
        <section
            data-testid="app-build-pull-token"
            className={cn(
                'rounded-lg p-4 space-y-3',
                'bg-card dark:bg-transparent',
                'border border-card-border dark:border-border-secondary-dark',
            )}
        >
            <div>
                <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('body')}
                </p>
                <ol className="mt-2 space-y-0.5 text-sm text-text-secondary dark:text-text-secondary-dark">
                    <li>{t('stepCreate')}</li>
                    <li>{t('stepPaste')}</li>
                </ol>
            </div>

            {pullAccess?.tokenSet && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {pullAccess.tokenExpiresAt
                        ? t('savedExpires', { date: formatDate(pullAccess.tokenExpiresAt) })
                        : t('tokenSet')}
                </p>
            )}

            <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
                <div className="min-w-64 flex-1">
                    <Input
                        label={t('label')}
                        type="password"
                        name="pullToken"
                        autoComplete="off"
                        value={token}
                        onChange={(event) => setToken(event.target.value)}
                        disabled={!canEdit || pending}
                        variant="form"
                        data-testid="app-build-pull-token-input"
                    />
                </div>
                <Button
                    type="submit"
                    variant="secondary"
                    size="md"
                    disabled={!canEdit || pending || token.trim().length === 0}
                    loading={pending}
                    title={canEdit ? undefined : t('viewerDisabled')}
                    data-testid="app-build-pull-token-submit"
                >
                    {pending ? t('saving') : t('submit')}
                </Button>
            </form>

            {!canEdit && (
                <p className="text-xs text-text-muted dark:text-text-muted-dark">
                    {t('viewerDisabled')}
                </p>
            )}

            {message && (
                <p
                    role={message.tone === 'error' ? 'alert' : 'status'}
                    className={cn(
                        'text-sm',
                        message.tone === 'error'
                            ? 'text-red-700 dark:text-red-300'
                            : 'text-emerald-700 dark:text-emerald-300',
                    )}
                >
                    {message.text}
                </p>
            )}
        </section>
    );
}
