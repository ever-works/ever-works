'use client';

import { useTranslations } from 'next-intl';
import type { AccountDeletionPreview } from '@/lib/api/account-deletion';

/**
 * "What will be deleted" — shared by Settings → Danger Zone and the public
 * email-link confirm page, so both say exactly the same thing.
 */
export function AccountDeletionSummary({ preview }: { preview: AccountDeletionPreview }) {
    const t = useTranslations('auth.deleteAccount.summary');

    return (
        <div className="space-y-3" data-testid="account-deletion-summary">
            <div className="rounded-lg border border-danger/25 bg-danger/5 p-4 space-y-2">
                <p className="text-sm font-semibold text-danger">{t('deletedTitle')}</p>
                <ul className="text-sm text-text-secondary dark:text-text-secondary-dark list-disc pl-5 space-y-1">
                    <li>{t('profile')}</li>
                    <li>{t('works', { count: preview.worksDeleted })}</li>
                    <li>{t('apiKeys', { count: preview.apiKeys })}</li>
                    {preview.hasSubscription && <li>{t('subscription')}</li>}
                    <li>{t('files')}</li>
                </ul>
            </div>

            {preview.accounts.map((account) => (
                <div
                    key={`${account.workspace}-${account.outcome}`}
                    className={
                        account.outcome === 'workspace-deleted'
                            ? 'rounded-lg border border-danger/25 p-4 space-y-1'
                            : 'rounded-lg border border-warning/40 bg-warning/5 p-4 space-y-1'
                    }
                    data-testid={`account-deletion-workspace-${account.outcome}`}
                >
                    <p className="text-sm font-semibold text-text dark:text-text-dark">
                        {t('workspaceTitle', {
                            name: account.workspace,
                            role: t(`roles.${account.role}`),
                        })}
                    </p>
                    {account.organizations.length > 0 && (
                        <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                            {t('organizations', { names: account.organizations.join(', ') })}
                        </p>
                    )}
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {account.outcome === 'workspace-deleted' && t('outcome.workspaceDeleted')}
                        {account.outcome === 'workspace-transferred' &&
                            t('outcome.workspaceTransferred', {
                                count: account.otherMembers,
                                newOwner: account.newOwner ?? '—',
                            })}
                        {account.outcome === 'account-removed' && t('outcome.accountRemoved')}
                    </p>
                    {account.outcome === 'workspace-transferred' && account.soleAdmin && (
                        <p className="text-xs font-medium text-warning" role="note">
                            {t('soleOwnerWarning', { newOwner: account.newOwner ?? '—' })}
                        </p>
                    )}
                </div>
            ))}

            {preview.worksKept > 0 && (
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark">
                    {t('worksKept', { count: preview.worksKept })}
                </p>
            )}

            <div className="rounded-lg border border-border dark:border-border-dark p-4 space-y-1">
                <p className="text-sm font-semibold text-text dark:text-text-dark">
                    {t('keptTitle')}
                </p>
                <ul className="text-xs text-text-secondary dark:text-text-secondary-dark list-disc pl-5 space-y-1">
                    <li>{t('kept.invoices')}</li>
                    <li>{t('kept.audit')}</li>
                    <li>{t('kept.backups')}</li>
                    <li>{t('kept.repositories')}</li>
                </ul>
            </div>
        </div>
    );
}
