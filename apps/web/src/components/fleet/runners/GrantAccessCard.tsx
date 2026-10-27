'use client';

import { useTranslations } from 'next-intl';
import { ExternalLink, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * Actions runners on computers (FL-18 P2, spec §5.6, FR-26, S7) — the card an
 * organisation target shows when the Ever Works GitHub App lacks the
 * permission to register runners there:
 *
 * ```
 *  Organisation runners need one more permission
 *  The Ever Works GitHub App on acme needs "Self-hosted runners: Read and write".
 *  Grant it on GitHub, then come back and press Check again.
 *                    [ Grant access ↗ ]  [ Check again ]  [ Use a repository instead ]
 * ```
 *
 * **Grant access** opens the installation's permission page on GitHub; the
 * platform never asks for a personal token. **Check again** re-asks the API;
 * **Use a repository instead** is offered when the caller can switch target.
 */
export function GrantAccessCard({
    account,
    permission,
    grantUrl,
    checking = false,
    onCheckAgain,
    onUseRepository,
    testId = 'fleet-runners-grant-access',
}: {
    /** The GitHub account (organisation) the App installation is on. */
    account: string;
    /** The exact GitHub permission name, when the API named it. */
    permission: string | null;
    /** The installation's page on GitHub. */
    grantUrl: string | null;
    /** A re-check is running. */
    checking?: boolean;
    onCheckAgain: () => void;
    onUseRepository?: () => void;
    testId?: string;
}) {
    const t = useTranslations('fleet.runners.grantAccess');
    return (
        <div
            className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-xs"
            role="status"
            data-testid={testId}
        >
            <p className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4" aria-hidden />
                {t('title')}
            </p>
            <p>{permission ? t('body', { account, permission }) : t('bodyUnnamed', { account })}</p>
            <div className="flex flex-wrap items-center gap-2">
                {grantUrl ? (
                    <a
                        href={grantUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium text-primary underline"
                        data-testid={`${testId}-grant`}
                    >
                        {t('grant')}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                    </a>
                ) : null}
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={onCheckAgain}
                    loading={checking}
                    data-testid={`${testId}-check`}
                >
                    {checking ? t('checking') : t('checkAgain')}
                </Button>
                {onUseRepository ? (
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={onUseRepository}
                        data-testid={`${testId}-use-repository`}
                    >
                        {t('useRepository')}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
