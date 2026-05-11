'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import { Github, ExternalLink, Loader2 } from 'lucide-react';
import { connectReadPackagesOAuthProvider } from '@/app/actions/dashboard/oauth';

interface GithubPackagesOAuthButtonProps {
    /** The plugin ID — always `'github'` today, but threaded so the
     *  component stays portable if another provider grows the same flow. */
    pluginId: string;
}

/**
 * Inline "Connect via GitHub" button rendered beside the
 * `readPackagesPat` secret input on the GitHub plugin settings form.
 *
 * Click → call `connectReadPackagesOAuthProvider` server action → server
 * builds the GitHub OAuth URL (with `scope=read:packages write:packages`
 * forced) → we redirect the whole window to GitHub. After auth GitHub
 * redirects back to `/api/oauth/github/read-packages/callback/plugins`,
 * which exchanges the code and writes the resulting token into the
 * user's `readPackagesPat` plugin setting. The page reloads with
 * `oauth_connected=true&oauth_intent=read_packages` so existing toast
 * machinery surfaces the result.
 */
export function GithubPackagesOAuthButton({ pluginId }: GithubPackagesOAuthButtonProps) {
    const t = useTranslations('dashboard.plugins.settingsField');
    const pathname = usePathname();
    const [isPending, startTransition] = useTransition();
    const [error, setError] = useState<string | null>(null);

    const handleConnect = () => {
        setError(null);
        startTransition(async () => {
            try {
                // Strip the locale prefix so the callback redirects back to
                // the same settings page the user is on. The server action
                // re-adds the locale via `redirect()` from next-intl.
                const returnPath = pathname?.replace(/^\/[a-z]{2}(?=\/|$)/, '') || undefined;
                const result = await connectReadPackagesOAuthProvider(
                    pluginId,
                    returnPath,
                    /* forceConsent */ true,
                );
                if (!result.success || !result.url) {
                    setError(result.error ?? t('githubPackagesOAuthFailed'));
                    return;
                }
                window.location.href = result.url;
            } catch (err) {
                setError(err instanceof Error ? err.message : t('githubPackagesOAuthFailed'));
            }
        });
    };

    return (
        <div className="space-y-1.5">
            <button
                type="button"
                onClick={handleConnect}
                disabled={isPending}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-border dark:border-border-dark bg-surface-secondary dark:bg-surface-secondary-dark text-sm font-medium text-text dark:text-text-dark hover:border-primary/50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
                {isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                    <Github className="w-4 h-4" />
                )}
                {t('githubPackagesOAuthConnect')}
                {!isPending && <ExternalLink className="w-3.5 h-3.5 opacity-60" />}
            </button>
            {error && <p className="text-xs text-danger">{error}</p>}
        </div>
    );
}
