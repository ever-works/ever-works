'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle, KeyRound, RefreshCw, Ban } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FleetEnrollmentTokenView } from '@/lib/api/fleet';

interface FleetTokensSectionProps {
    tokens: FleetEnrollmentTokenView[];
    loading: boolean;
    error: string | null;
    isPending: boolean;
    onRefresh: () => void;
    onRevoke: (token: FleetEnrollmentTokenView) => void;
}

function formatMoment(value: string | null): string {
    if (!value) return '-';
    try {
        return new Date(value).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return value;
    }
}

/**
 * Outstanding enrollment tokens — every credential that has been minted
 * and not yet used, with a revoke button next to each.
 *
 * Without this the only trace of an issued token was a toast that had
 * long since disappeared: an operator who minted a token, got
 * distracted, and never enrolled the machine had no way to see that a
 * usable credential was out there, and no way to kill it short of
 * deleting the node row by guesswork. Both halves matter — SEEING the
 * outstanding set is what makes revoking it possible.
 *
 * Expired rows stay listed (marked as such) on purpose: a stale
 * credential row is exactly the thing worth cleaning up, and hiding it
 * would make this list disagree with the node table above.
 */
export function FleetTokensSection({
    tokens,
    loading,
    error,
    isPending,
    onRefresh,
    onRevoke,
}: FleetTokensSectionProps) {
    const t = useTranslations('dashboard.settings.fleet');

    return (
        <div className="space-y-3" data-testid="fleet-tokens-section">
            <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                    <KeyRound className="w-4 h-4 text-text-muted dark:text-text-muted-dark" />
                    <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('tokens.title')}
                    </h3>
                </div>
                <Button
                    variant="ghost"
                    onClick={onRefresh}
                    disabled={loading}
                    title={t('tokens.refresh')}
                    data-testid="fleet-tokens-refresh"
                >
                    <RefreshCw className="w-4 h-4" />
                </Button>
            </div>
            <p className="text-xs text-text-muted dark:text-text-muted-dark">
                {t('tokens.description')}
            </p>

            {error ? (
                <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-lg">
                    <AlertTriangle className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-text dark:text-text-dark">{error}</p>
                </div>
            ) : tokens.length === 0 ? (
                <p
                    className="text-sm text-text-muted dark:text-text-muted-dark"
                    data-testid="fleet-tokens-empty"
                >
                    {loading ? t('tokens.loading') : t('tokens.empty')}
                </p>
            ) : (
                <div className="overflow-x-auto rounded-lg border border-border dark:border-border-dark">
                    <table className="w-full text-sm" data-testid="fleet-tokens-table">
                        <thead>
                            <tr className="border-b border-border dark:border-border-dark bg-surface-secondary/40 dark:bg-surface-secondary-dark/40 text-left">
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('table.name')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('table.kind')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('tokens.issuedAt')}
                                </th>
                                <th className="px-4 py-2.5 font-medium text-text-muted dark:text-text-muted-dark">
                                    {t('tokens.expiresAt')}
                                </th>
                                <th className="px-4 py-2.5" />
                            </tr>
                        </thead>
                        <tbody>
                            {tokens.map((token) => (
                                <tr
                                    key={token.nodeId}
                                    className="border-b last:border-b-0 border-border dark:border-border-dark"
                                    data-testid={`fleet-token-row-${token.nodeId}`}
                                >
                                    <td className="px-4 py-3 font-medium text-text dark:text-text-dark">
                                        {token.name}
                                        {token.rotated ? (
                                            <span className="ml-2 px-1.5 py-0.5 rounded text-xs bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark">
                                                {t('tokens.rotated')}
                                            </span>
                                        ) : null}
                                    </td>
                                    <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark">
                                        {t(`kinds.${token.kind}` as never)}
                                    </td>
                                    <td className="px-4 py-3 text-text-muted dark:text-text-muted-dark whitespace-nowrap">
                                        {formatMoment(token.issuedAt)}
                                    </td>
                                    <td className="px-4 py-3 whitespace-nowrap">
                                        <span
                                            className={
                                                token.expired
                                                    ? 'text-danger'
                                                    : 'text-text-muted dark:text-text-muted-dark'
                                            }
                                            data-testid={`fleet-token-expiry-${token.nodeId}`}
                                        >
                                            {token.expired
                                                ? t('tokens.expired')
                                                : formatMoment(token.expiresAt)}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3">
                                        <div className="flex justify-end">
                                            <Button
                                                variant="ghost"
                                                onClick={() => onRevoke(token)}
                                                disabled={isPending}
                                                title={t('tokens.revoke')}
                                                data-testid={`fleet-token-revoke-${token.nodeId}`}
                                            >
                                                <Ban className="w-4 h-4 text-danger" />
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
