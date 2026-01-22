'use client';

import { useState, useTransition } from 'react';
import { cn } from '@/lib/utils/cn';
import {
    updateVercelToken,
    removeVercelToken,
    updateScreenshotOneKeys,
    removeScreenshotOneKeys,
} from '@/app/actions/settings';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { UserProfile } from '@/lib/api';

interface ApiTokenSettingsProps {
    user: UserProfile;
}

export function ApiTokenSettings({ user }: ApiTokenSettingsProps) {
    const [isPending, startTransition] = useTransition();
    const [vercelToken, setVercelToken] = useState(user.vercelToken || '');
    const [hasVercelToken, setHasVercelToken] = useState(!!user.vercelToken);
    const [showToken, setShowToken] = useState(false);

    // ScreenshotOne state
    const [screenshotoneAccessKey, setScreenshotoneAccessKey] = useState(
        user.screenshotoneAccessKey || '',
    );
    const [screenshotoneSecretKey, setScreenshotoneSecretKey] = useState(
        user.screenshotoneSecretKey || '',
    );
    const [hasScreenshotoneKey, setHasScreenshotoneKey] = useState(!!user.screenshotoneAccessKey);
    const [showScreenshotoneKey, setShowScreenshotoneKey] = useState(false);
    const [showScreenshotoneSecretKey, setShowScreenshotoneSecretKey] = useState(false);

    const t = useTranslations('dashboard.apiTokens');

    const handleSaveVercelToken = () => {
        if (!vercelToken.trim()) {
            toast.error(t('vercel.messages.tokenRequired'));
            return;
        }

        startTransition(async () => {
            try {
                const result = await updateVercelToken(vercelToken.trim());

                if (result.success) {
                    toast.success(t('vercel.messages.saveSuccess'));
                    setHasVercelToken(true);
                    setVercelToken('');
                    setShowToken(false);
                } else {
                    toast.error(result.error || t('vercel.messages.saveFailed'));
                }
            } catch (error) {
                toast.error(t('vercel.messages.unexpectedError'));
            }
        });
    };

    const handleRemoveVercelToken = () => {
        startTransition(async () => {
            try {
                const result = await removeVercelToken();

                if (result.success) {
                    toast.success(t('vercel.messages.removeSuccess'));
                    setVercelToken('');
                    setHasVercelToken(false);
                } else {
                    toast.error(result.error || t('vercel.messages.removeFailed'));
                }
            } catch (error) {
                toast.error(t('vercel.messages.unexpectedError'));
            }
        });
    };

    // ScreenshotOne handlers
    const handleSaveScreenshotoneKeys = () => {
        if (!screenshotoneAccessKey.trim()) {
            toast.error(t('screenshotone.messages.accessKeyRequired'));
            return;
        }

        startTransition(async () => {
            try {
                const result = await updateScreenshotOneKeys(
                    screenshotoneAccessKey.trim(),
                    screenshotoneSecretKey.trim() || undefined,
                );

                if (result.success) {
                    toast.success(t('screenshotone.messages.saveSuccess'));
                    setHasScreenshotoneKey(true);
                    setScreenshotoneAccessKey('');
                    setScreenshotoneSecretKey('');
                    setShowScreenshotoneKey(false);
                    setShowScreenshotoneSecretKey(false);
                } else {
                    toast.error(result.error || t('screenshotone.messages.saveFailed'));
                }
            } catch (error) {
                toast.error(t('screenshotone.messages.unexpectedError'));
            }
        });
    };

    const handleRemoveScreenshotoneKeys = () => {
        startTransition(async () => {
            try {
                const result = await removeScreenshotOneKeys();

                if (result.success) {
                    toast.success(t('screenshotone.messages.removeSuccess'));
                    setScreenshotoneAccessKey('');
                    setScreenshotoneSecretKey('');
                    setHasScreenshotoneKey(false);
                } else {
                    toast.error(result.error || t('screenshotone.messages.removeFailed'));
                }
            } catch (error) {
                toast.error(t('screenshotone.messages.unexpectedError'));
            }
        });
    };

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-xl font-semibold text-text dark:text-text-dark mb-4">
                    {t('title')}
                </h2>
                <p className="text-text-muted dark:text-text-muted-dark text-sm">{t('subtitle')}</p>
            </div>

            {/* Vercel Integration */}
            <div className="space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-medium text-text dark:text-text-dark">
                            {t('vercel.title')}
                        </h3>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                            {t('vercel.subtitle')}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <span
                            className={cn(
                                'px-2 py-1 rounded text-xs font-medium',
                                hasVercelToken
                                    ? 'bg-success/10 text-success'
                                    : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark',
                            )}
                        >
                            {hasVercelToken ? t('vercel.connected') : t('vercel.notConnected')}
                        </span>
                    </div>
                </div>

                {hasVercelToken ? (
                    <div className="p-4 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark">
                        <p className="text-sm text-text dark:text-text-dark mb-3">
                            {t('vercel.connectedMessage')}
                        </p>
                        <button
                            onClick={handleRemoveVercelToken}
                            disabled={isPending}
                            className={cn(
                                'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                'bg-danger/10 text-danger hover:bg-danger/20',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            {isPending ? t('vercel.disconnecting') : t('vercel.disconnect')}
                        </button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                {t('vercel.apiTokenLabel')}
                            </label>
                            <div className="relative">
                                <input
                                    type={showToken ? 'text' : 'password'}
                                    value={vercelToken}
                                    onChange={(e) => setVercelToken(e.target.value)}
                                    className={cn(
                                        'w-full px-4 py-2 pr-24 rounded-lg',
                                        'bg-surface dark:bg-surface-dark',
                                        'border border-border dark:border-border-dark',
                                        'text-text dark:text-text-dark',
                                        'focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-primary-dark',
                                        'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                        'font-mono',
                                    )}
                                    placeholder={t('vercel.placeholder')}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowToken(!showToken)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                                >
                                    {showToken ? t('vercel.hideToken') : t('vercel.showToken')}
                                </button>
                            </div>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-2">
                                {t('vercel.getTokenHelp')}{' '}
                                <a
                                    href="https://vercel.com/account/tokens"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary dark:text-primary-dark hover:underline"
                                >
                                    {t('vercel.vercelDashboard')}
                                </a>
                            </p>
                        </div>

                        <div className="flex justify-end">
                            <button
                                onClick={handleSaveVercelToken}
                                disabled={isPending || !vercelToken}
                                className={cn(
                                    'px-6 py-2 rounded-lg font-medium transition-colors',
                                    'bg-primary dark:bg-primary-dark text-white',
                                    'hover:bg-primary/90 dark:hover:bg-primary-dark/90',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                {isPending ? t('vercel.saving') : t('vercel.save')}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ScreenshotOne Integration */}
            <div className="pt-6 border-t border-border dark:border-border-dark space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-lg font-medium text-text dark:text-text-dark">
                            {t('screenshotone.title')}
                        </h3>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark mt-1">
                            {t('screenshotone.subtitle')}
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        <span
                            className={cn(
                                'px-2 py-1 rounded text-xs font-medium',
                                hasScreenshotoneKey
                                    ? 'bg-success/10 text-success'
                                    : 'bg-surface-secondary dark:bg-surface-secondary-dark text-text-muted dark:text-text-muted-dark',
                            )}
                        >
                            {hasScreenshotoneKey
                                ? t('screenshotone.connected')
                                : t('screenshotone.notConnected')}
                        </span>
                    </div>
                </div>

                {hasScreenshotoneKey ? (
                    <div className="p-4 rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark">
                        <p className="text-sm text-text dark:text-text-dark mb-3">
                            {t('screenshotone.connectedMessage')}
                        </p>
                        <button
                            onClick={handleRemoveScreenshotoneKeys}
                            disabled={isPending}
                            className={cn(
                                'px-4 py-2 rounded-lg text-sm font-medium transition-colors',
                                'bg-danger/10 text-danger hover:bg-danger/20',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            {isPending
                                ? t('screenshotone.disconnecting')
                                : t('screenshotone.disconnect')}
                        </button>
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                {t('screenshotone.accessKeyLabel')}
                            </label>
                            <div className="relative">
                                <input
                                    type={showScreenshotoneKey ? 'text' : 'password'}
                                    value={screenshotoneAccessKey}
                                    onChange={(e) => setScreenshotoneAccessKey(e.target.value)}
                                    className={cn(
                                        'w-full px-4 py-2 pr-24 rounded-lg',
                                        'bg-surface dark:bg-surface-dark',
                                        'border border-border dark:border-border-dark',
                                        'text-text dark:text-text-dark',
                                        'focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-primary-dark',
                                        'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                        'font-mono',
                                    )}
                                    placeholder={t('screenshotone.placeholder')}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowScreenshotoneKey(!showScreenshotoneKey)}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                                >
                                    {showScreenshotoneKey
                                        ? t('screenshotone.hideKey')
                                        : t('screenshotone.showKey')}
                                </button>
                            </div>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-2">
                                {t('screenshotone.accessKeyHelp')}
                            </p>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-text dark:text-text-dark mb-2">
                                {t('screenshotone.secretKeyLabel')}
                            </label>
                            <div className="relative">
                                <input
                                    type={showScreenshotoneSecretKey ? 'text' : 'password'}
                                    value={screenshotoneSecretKey}
                                    onChange={(e) => setScreenshotoneSecretKey(e.target.value)}
                                    className={cn(
                                        'w-full px-4 py-2 pr-24 rounded-lg',
                                        'bg-surface dark:bg-surface-dark',
                                        'border border-border dark:border-border-dark',
                                        'text-text dark:text-text-dark',
                                        'focus:outline-none focus:ring-2 focus:ring-primary dark:focus:ring-primary-dark',
                                        'placeholder:text-text-muted dark:placeholder:text-text-muted-dark',
                                        'font-mono',
                                    )}
                                    placeholder={t('screenshotone.secretKeyPlaceholder')}
                                />
                                <button
                                    type="button"
                                    onClick={() =>
                                        setShowScreenshotoneSecretKey(!showScreenshotoneSecretKey)
                                    }
                                    className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
                                >
                                    {showScreenshotoneSecretKey
                                        ? t('screenshotone.hideKey')
                                        : t('screenshotone.showKey')}
                                </button>
                            </div>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-2">
                                {t('screenshotone.secretKeyHelp')}{' '}
                                <a
                                    href="https://dash.screenshotone.com/dashboard"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-primary dark:text-primary-dark hover:underline"
                                >
                                    {t('screenshotone.dashboard')}
                                </a>
                            </p>
                        </div>

                        <div className="flex justify-end">
                            <button
                                onClick={handleSaveScreenshotoneKeys}
                                disabled={isPending || !screenshotoneAccessKey}
                                className={cn(
                                    'px-6 py-2 rounded-lg font-medium transition-colors',
                                    'bg-primary dark:bg-primary-dark text-white',
                                    'hover:bg-primary/90 dark:hover:bg-primary-dark/90',
                                    'disabled:opacity-50 disabled:cursor-not-allowed',
                                )}
                            >
                                {isPending ? t('screenshotone.saving') : t('screenshotone.save')}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* API Keys Section */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    {t('apiKeys.title')}
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('apiKeys.subtitle')}
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
                    {t('apiKeys.generate')}
                </button>
            </div>

            {/* Webhooks */}
            <div className="pt-6 border-t border-border dark:border-border-dark">
                <h3 className="text-lg font-medium text-text dark:text-text-dark mb-2">
                    {t('webhooks.title')}
                </h3>
                <p className="text-sm text-text-muted dark:text-text-muted-dark mb-4">
                    {t('webhooks.subtitle')}
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
                    {t('webhooks.configure')}
                </button>
            </div>
        </div>
    );
}
