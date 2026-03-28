'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { useSearchParams } from 'next/navigation';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const DISMISS_KEY_PREFIX = 'github_connect_dismissed';

interface ConnectGithubModalProps {
    userId: string;
    hasGithubConnected: boolean;
}
type LinkSocialResponse = {
    url?: string;
    redirect?: boolean;
    status?: boolean;
};

export function ConnectGithubModal({ userId, hasGithubConnected }: ConnectGithubModalProps) {
    const t = useTranslations('dashboard.connectGithub');
    const pathname = usePathname();
    const router = useRouter();
    const searchParams = useSearchParams();
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const shouldForcePrompt = searchParams.get('connectGithub') === '1';
    const dismissKey = `${DISMISS_KEY_PREFIX}:${userId}`;

    useEffect(() => {
        if (hasGithubConnected) return;

        const dismissed = localStorage.getItem(dismissKey);
        if (shouldForcePrompt || !dismissed) {
            setOpen(true);
        }
    }, [dismissKey, hasGithubConnected, shouldForcePrompt]);

    const handleConnect = async () => {
        setLoading(true);
        try {
            const callbackURL = `${window.location.origin}${pathname}`;
            const response = await fetch('/api/auth/better-auth/link-social', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                credentials: 'include',
                body: JSON.stringify({
                    provider: 'github',
                    callbackURL,
                    disableRedirect: true,
                }),
            });

            if (!response.ok) {
                throw new Error(`Failed to start GitHub linking flow (${response.status})`);
            }

            const data = (await response.json()) as LinkSocialResponse;

            if (!data.url) {
                throw new Error('BetterAuth did not return a GitHub authorization URL');
            }

            window.location.assign(data.url);
        } catch (error) {
            console.error('Failed to connect GitHub:', error);
            setLoading(false);
        }
    };

    const handleDismiss = () => {
        localStorage.setItem(dismissKey, 'true');
        setOpen(false);
        if (shouldForcePrompt) {
            router.replace(pathname);
        }
    };

    if (hasGithubConnected) return null;

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) {
                    handleDismiss();
                    return;
                }
                setOpen(nextOpen);
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-surface-secondary dark:bg-surface-secondary-dark">
                        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                        </svg>
                    </div>
                    <DialogTitle className="text-center">{t('title')}</DialogTitle>
                    <DialogDescription className="text-center">
                        {t('description')}
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 mt-4">
                    <Button onClick={handleConnect} disabled={loading}>
                        <svg className="w-4 h-4 mr-2" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                        </svg>
                        {t('connect')}
                    </Button>
                    <Button variant="ghost" onClick={handleDismiss}>
                        {t('dismiss')}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
