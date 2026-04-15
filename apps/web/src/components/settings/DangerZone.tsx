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
        <div className="space-y-3">
            <div>
                <h2 className="text-xl font-semibold text-danger mb-4">{t('title')}</h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>
            <div className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark overflow-hidden">
                <div className="p-5">
                    <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-semibold text-text dark:text-text-dark">
                                {t('export.title')}
                            </h3>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 leading-relaxed">
                                {t('export.subtitle')}
                            </p>
                        </div>
                        <button
                            disabled
                            className={cn(
                                'shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium',
                                'bg-surface-secondary dark:bg-surface-secondary-dark',
                                'text-text-muted dark:text-text-muted-dark',
                                'cursor-not-allowed opacity-50',
                            )}
                        >
                            {t('export.action')}
                        </button>
                    </div>
                </div>
            </div>

            {/* Delete Account */}
            <div className="rounded-xl border border-danger/25 dark:border-danger/20 bg-card dark:bg-card-primary-dark overflow-hidden">
                <div className="p-5">
                    <div
                        className={cn(
                            'flex items-start gap-4',
                            showDeleteConfirm ? 'flex-col' : 'justify-between',
                        )}
                    >
                        <div className="min-w-0 flex-1">
                            <h3 className="text-sm font-semibold text-danger">
                                {t('delete.title')}
                            </h3>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 leading-relaxed">
                                {t('delete.subtitle')}
                            </p>
                        </div>

                        {!showDeleteConfirm ? (
                            <button
                                onClick={() => setShowDeleteConfirm(true)}
                                className={cn(
                                    'shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                                    'bg-danger/10 dark:bg-danger/15 text-danger border border-danger/20',
                                    'hover:bg-danger hover:text-white hover:border-danger',
                                )}
                            >
                                {t('delete.button')}
                            </button>
                        ) : (
                            <div className="w-full space-y-4 pt-1">
                                <div className="p-3.5 rounded-lg bg-danger/5 dark:bg-danger/8 border border-danger/15">
                                    <p className="text-xs font-semibold text-danger mb-2">
                                        {t('delete.confirmTitle')}
                                    </p>
                                    <ul className="text-xs text-text-muted dark:text-text-muted-dark space-y-1 pl-4 list-disc">
                                        <li>{t('delete.confirmItems.0')}</li>
                                        <li>{t('delete.confirmItems.1')}</li>
                                        <li>{t('delete.confirmItems.2')}</li>
                                        <li>{t('delete.confirmItems.3')}</li>
                                        <li>{t('delete.confirmItems.4')}</li>
                                    </ul>
                                </div>

                                <div>
                                    <label className="block text-xs font-medium text-text dark:text-text-dark mb-1.5">
                                        {t('delete.confirmLabel', { email: user.email })}
                                    </label>
                                    <input
                                        type="email"
                                        value={confirmEmail}
                                        onChange={(e) => setConfirmEmail(e.target.value)}
                                        className={cn(
                                            'w-full px-3 py-2 rounded-lg text-xs',
                                            'bg-surface dark:bg-surface-dark',
                                            'border border-danger/40 dark:border-danger/30',
                                            'text-text dark:text-text-dark',
                                            'focus:outline-none focus:ring-2 focus:ring-danger/20',
                                            'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                        )}
                                        placeholder={t('delete.confirmPlaceholder')}
                                    />
                                </div>

                                <div className="flex gap-2">
                                    <button
                                        onClick={handleDeleteAccount}
                                        disabled={isPending || confirmEmail !== user.email}
                                        className={cn(
                                            'px-3.5 py-1.5 rounded-lg text-xs font-medium transition-colors',
                                            'bg-danger text-white',
                                            confirmEmail === user.email
                                                ? 'hover:bg-danger/90'
                                                : 'opacity-40 cursor-not-allowed',
                                        )}
                                    >
                                        {isPending
                                            ? t('delete.deleting')
                                            : t('delete.confirmButton')}
                                    </button>
                                    <button
                                        onClick={() => {
                                            setShowDeleteConfirm(false);
                                            setConfirmEmail('');
                                        }}
                                        disabled={isPending}
                                        className={cn(
                                            'px-3.5 cursor-pointer py-1.5 rounded-lg text-xs font-medium transition-colors',
                                            'border border-border/60 dark:border-border-dark/60',
                                            'text-text-secondary dark:text-text-secondary-dark',
                                            'hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark',
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
            </div>
        </div>
    );
}
