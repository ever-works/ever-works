'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Check, ChevronDown, ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import { enablePlugin } from '@/app/actions/plugins';
import { OnboardingPluginStep } from '../OnboardingPluginStep';
import type { UserPlugin } from '@/lib/api/plugins';
import type { OAuthConnectionInfo } from '@/lib/api/plugins-capabilities/oauth';
import type { GitProviderConnectionInfo } from '@/lib/api/plugins-capabilities/git-providers';

const ICON_CLASS = 'h-5 w-5';

/** Plugin id backing the Slack card. Mirrors the ids the wizard already
 *  hard-codes for the GitHub / Postgres steps. */
export const SLACK_CONNECTOR_PLUGIN_ID = 'slack-connector';

/** Monochrome Slack mark (four lozenges), rendered at currentColor. */
function SlackMark() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={ICON_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="M5.1 15.2a2.1 2.1 0 1 1-2.1-2.1h2.1v2.1zm1 0a2.1 2.1 0 0 1 4.2 0v5.2a2.1 2.1 0 1 1-4.2 0v-5.2zM8.2 5a2.1 2.1 0 1 1 2.1-2.1V5H8.2zm0 1.1a2.1 2.1 0 0 1 0 4.2H3a2.1 2.1 0 1 1 0-4.2h5.2zM18.9 8.8a2.1 2.1 0 1 1 2.1 2.1h-2.1V8.8zm-1 0a2.1 2.1 0 0 1-4.2 0V3.6a2.1 2.1 0 1 1 4.2 0v5.2zM15.8 19a2.1 2.1 0 1 1-2.1 2.1V19h2.1zm0-1.1a2.1 2.1 0 0 1 0-4.2H21a2.1 2.1 0 1 1 0 4.2h-5.2z" />
        </svg>
    );
}

/** Monochrome Discord mark, rendered at currentColor. */
function DiscordMark() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className={ICON_CLASS}
            aria-hidden="true"
            fill="currentColor"
        >
            <path d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.25a18.3 18.3 0 0 0-5.49 0 12.6 12.6 0 0 0-.61-1.25.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.88 1.52.07.07 0 0 0-.04.03C.53 9.05-.32 13.58.1 18.06c0 .02.01.04.03.05a19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.02c.46-.63.87-1.3 1.22-2a.08.08 0 0 0-.04-.1 13 13 0 0 1-1.87-.9.08.08 0 0 1-.01-.12c.13-.1.25-.19.37-.29a.07.07 0 0 1 .08-.01c3.93 1.8 8.18 1.8 12.06 0a.07.07 0 0 1 .08 0c.12.11.25.2.37.3a.08.08 0 0 1 0 .12c-.6.35-1.22.64-1.88.9a.08.08 0 0 0-.04.1c.36.7.78 1.37 1.22 2a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6.02-3.04.08.08 0 0 0 .03-.05c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03zM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42zm7.97 0c-1.18 0-2.15-1.08-2.15-2.42 0-1.33.95-2.42 2.15-2.42 1.22 0 2.18 1.1 2.16 2.42 0 1.34-.94 2.42-2.16 2.42z" />
        </svg>
    );
}

export interface CommunicationStepProps {
    /**
     * The `slack-connector` plugin as returned by `GET /api/plugins`, when
     * it is installed in this environment. Present ⇒ the card connects in
     * place; absent ⇒ the card falls back to the Settings → Plugins link
     * (self-hosted images that ship without the connector).
     */
    readonly slackPlugin?: UserPlugin | null;
    readonly slackConnection?: OAuthConnectionInfo | GitProviderConnectionInfo | null;
    readonly isStatusLoading?: boolean;
    /** Fired after a successful enable so the wizard can refresh statuses. */
    readonly onConnected?: (pluginId: string) => void;
}

/**
 * "Communication" step (Wave 6, feature b) — connect the chat
 * workspaces the org lives in.
 *
 * Audit item (b): the Slack card used to be a link OUT to
 * `/plugins/slack-connector`, which dropped the user out of the wizard
 * mid-flow. It now connects IN PLACE: expanding the card renders the
 * connector's own settings panel (`OnboardingPluginStep` — the exact
 * component every other config step uses, so the bot token / signing
 * secret / default channel fields and their save+validate round-trip are
 * unchanged) plus an Enable action wired to the existing
 * `enablePlugin` server action.
 *
 * The link to the full plugin settings page is kept as a secondary
 * affordance — additive, not a replacement.
 *
 * Discord shows a coming-soon chip. The step is always skippable via the
 * wizard footer.
 */
export function CommunicationStep({
    slackPlugin,
    slackConnection,
    isStatusLoading,
    onConnected,
}: CommunicationStepProps = {}) {
    const t = useTranslations('onboarding.communicationStep');
    const [expanded, setExpanded] = useState(false);
    const canConnectInPlace = Boolean(slackPlugin);

    return (
        <div className="space-y-5 max-w-3xl">
            <header>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h3>
                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                    {t('description')}
                </p>
            </header>

            <div className="space-y-2">
                <div
                    className={cn(
                        'rounded-lg border bg-surface dark:bg-surface-dark transition-all',
                        expanded
                            ? 'border-primary/40 shadow-sm'
                            : 'border-border dark:border-border-dark hover:border-border-secondary dark:hover:border-white/15',
                    )}
                >
                    <div className="flex items-start gap-3 p-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary dark:bg-white/5 text-text dark:text-text-dark">
                            <SlackMark />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold text-text dark:text-text-dark truncate">
                                    {t('slack.name')}
                                </p>
                                {canConnectInPlace ? (
                                    <Button
                                        size="sm"
                                        variant={expanded ? 'ghost' : 'secondary'}
                                        aria-expanded={expanded}
                                        data-testid="onboarding-communication-connect-slack"
                                        onClick={() => setExpanded((open) => !open)}
                                    >
                                        {expanded ? t('slack.close') : t('slack.action')}
                                        <ChevronDown
                                            className={cn(
                                                'ml-1.5 h-3.5 w-3.5 transition-transform',
                                                expanded && 'rotate-180',
                                            )}
                                        />
                                    </Button>
                                ) : (
                                    <Button size="sm" variant="secondary" asChild>
                                        <Link
                                            href={`${ROUTES.DASHBOARD_PLUGINS}/${SLACK_CONNECTOR_PLUGIN_ID}`}
                                            data-testid="onboarding-communication-connect-slack"
                                        >
                                            {t('slack.action')}
                                            <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                                        </Link>
                                    </Button>
                                )}
                            </div>
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                                {t('slack.description')}
                            </p>
                        </div>
                    </div>

                    {expanded && slackPlugin ? (
                        <div
                            className="border-t border-border dark:border-border-dark px-4 py-3 space-y-4"
                            data-testid="onboarding-communication-slack-panel"
                        >
                            <OnboardingPluginStep
                                plugin={slackPlugin}
                                connection={slackConnection}
                                isStatusLoading={isStatusLoading}
                            />
                            <SlackEnableRow plugin={slackPlugin} onConnected={onConnected} />
                        </div>
                    ) : null}
                </div>

                <div className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark opacity-80">
                    <div className="flex items-start gap-3 p-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary dark:bg-white/5 text-text-muted dark:text-text-muted-dark">
                            <DiscordMark />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold text-text dark:text-text-dark truncate">
                                    {t('discord.name')}
                                </p>
                                <span
                                    className="inline-flex items-center rounded-full bg-surface-secondary dark:bg-white/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-text-muted dark:text-text-muted-dark"
                                    data-testid="onboarding-communication-discord-soon"
                                >
                                    {t('discord.comingSoon')}
                                </span>
                            </div>
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                                {t('discord.description')}
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            <p className="text-xs text-text-muted dark:text-text-muted-dark">{t('skipHint')}</p>
        </div>
    );
}

// ─── In-place enable ────────────────────────────────────────────────────────

/**
 * Enable row for the expanded Slack card. Saving credentials
 * (`OnboardingPluginStep`) and enabling the plugin are two distinct
 * server operations in this codebase, so both are offered here rather
 * than being conflated: the user pastes the bot token, saves, then flips
 * the connector on without leaving the wizard.
 *
 * The Settings → Plugins link is kept as a secondary escape hatch for
 * everything the compact panel doesn't cover (per-Work overrides,
 * disable, advanced fields).
 */
function SlackEnableRow({
    plugin,
    onConnected,
}: {
    readonly plugin: UserPlugin;
    readonly onConnected?: (pluginId: string) => void;
}) {
    const t = useTranslations('onboarding.communicationStep');
    const [enabled, setEnabled] = useState(Boolean(plugin.enabled));
    const [isEnabling, setIsEnabling] = useState(false);

    const handleEnable = useCallback(async () => {
        setIsEnabling(true);
        try {
            const result = await enablePlugin(plugin.pluginId);
            if (result.success) {
                setEnabled(true);
                toast.success(t('slack.enabledToast'));
                onConnected?.(plugin.pluginId);
            } else {
                toast.error(result.error ?? t('slack.enableFailed'));
            }
        } finally {
            setIsEnabling(false);
        }
    }, [onConnected, plugin.pluginId, t]);

    return (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border dark:border-border-dark pt-3">
            {enabled ? (
                <span
                    className="inline-flex items-center gap-1.5 text-sm text-success"
                    data-testid="onboarding-communication-slack-enabled"
                >
                    <Check className="h-4 w-4" />
                    {t('slack.enabled')}
                </span>
            ) : (
                <Button
                    size="sm"
                    loading={isEnabling}
                    data-testid="onboarding-communication-slack-enable"
                    onClick={() => void handleEnable()}
                >
                    {t('slack.enable')}
                </Button>
            )}

            <Link
                href={`${ROUTES.DASHBOARD_PLUGINS}/${plugin.pluginId}`}
                data-testid="onboarding-communication-slack-settings-link"
                className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark underline hover:text-primary"
            >
                {t('slack.advancedSettings')}
                <ExternalLink className="h-3 w-3" />
            </Link>
        </div>
    );
}
