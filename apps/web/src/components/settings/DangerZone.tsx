'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import { deleteAccount } from '@/app/actions/settings';
import { toast } from 'sonner';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { useTranslations } from 'next-intl';

interface DangerZoneProps {
    user: {
        id: string;
        email: string;
    };
}

export function DangerZone({ user }: DangerZoneProps) {
    const router = useRouter();
    const [isPending, startTransition] = useTransition();
    const [confirmEmail, setConfirmEmail] = useState('');
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const t = useTranslations('dashboard.dangerZone');

    const handleDeleteAccount = () => {
        if (confirmEmail !== user.email) {
            toast.error(t('messages.confirmEmail'));
            return;
        }

        startTransition(async () => {
            try {
                const result = await deleteAccount();

                if (result.success) {
                    toast.success(t('messages.deleteSuccess'));
                    router.push(ROUTES.AUTH_REGISTER);
                } else {
                    toast.error(result.error || t('messages.deleteFailed'));
                }
            } catch (error) {
                toast.error(t('messages.unexpectedError'));
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-danger mb-4">{t('title')}</h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {/* Export Data */}
            <div className="p-4 rounded-lg border border-danger/20 bg-danger/5">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    {t('export.title')}
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('export.subtitle')}
                </p>
                <button
                    disabled
                    className={cn(
                        'px-4 py-2 rounded-lg text-sm font-medium',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'text-text-muted dark:text-text-muted-dark',
                        'cursor-not-allowed opacity-50',
                    )}
                >
                    {t('export.action')}
                </button>
            </div>

            {/* Delete Account */}
            <div className="p-4 rounded-lg border border-danger/20 bg-danger/5">
                <h3 className="text-lg font-medium text-danger mb-2">{t('delete.title')}</h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('delete.subtitle')}
                </p>

                {!showDeleteConfirm ? (
                    <button
                        onClick={() => setShowDeleteConfirm(true)}
                        className={cn(
                            'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                            'bg-danger text-white hover:bg-danger/90',
                        )}
                    >
                        {t('delete.button')}
                    </button>
                ) : (
                    <div className="space-y-4">
                        <div className="p-3 rounded bg-danger/10 border border-danger/30">
                            <p className="text-sm text-danger font-medium mb-2">
                                {t('delete.confirmTitle')}
                            </p>
                            <ul className="text-sm text-text-muted dark:text-text-muted-dark space-y-1 ml-5 list-disc">
                                <li>{t('delete.confirmItems.0')}</li>
                                <li>{t('delete.confirmItems.1')}</li>
                                <li>{t('delete.confirmItems.2')}</li>
                                <li>{t('delete.confirmItems.3')}</li>
                                <li>{t('delete.confirmItems.4')}</li>
                            </ul>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                {t('delete.confirmLabel', { email: user.email })}
                            </label>
                            <input
                                type="email"
                                value={confirmEmail}
                                onChange={(e) => setConfirmEmail(e.target.value)}
                                className={cn(
                                    'w-full px-4 py-2 rounded-lg',
                                    'bg-surface dark:bg-surface-dark',
                                    'border border-danger',
                                    'text-text dark:text-text-dark',
                                    'focus:outline-none focus:ring-2 focus:ring-danger',
                                    'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                )}
                                placeholder={t('delete.confirmPlaceholder')}
                            />
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={handleDeleteAccount}
                                disabled={isPending || confirmEmail !== user.email}
                                className={cn(
                                    'px-6 py-2 rounded-lg font-medium transition-colors',
                                    'bg-danger text-white',
                                    confirmEmail === user.email
                                        ? 'hover:bg-danger/90'
                                        : 'opacity-50 cursor-not-allowed',
                                )}
                            >
                                {isPending ? t('delete.deleting') : t('delete.confirmButton')}
                            </button>
                            <button
                                onClick={() => {
                                    setShowDeleteConfirm(false);
                                    setConfirmEmail('');
                                }}
                                disabled={isPending}
                                className={cn(
                                    'px-6 py-2 rounded-lg font-medium transition-colors',
                                    'bg-surface-secondary dark:bg-surface-secondary-dark',
                                    'text-text dark:text-text-dark',
                                    'hover:bg-surface dark:hover:bg-surface-dark',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                {t('delete.cancel')}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
