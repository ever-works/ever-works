'use client';

import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { ROUTES } from '@/lib/constants';

const ICON_CLASS = 'h-5 w-5';

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

/**
 * "Communication" step (Wave 6, feature b) — connect the chat
 * workspaces the org lives in. The Slack card links to the
 * slack-connector plugin settings page (bot token + signing secret +
 * default channel), where the platform-side Slack app wiring lives;
 * Discord shows a coming-soon chip. The step is additive and always
 * skippable via the wizard footer.
 */
export function CommunicationStep() {
    const t = useTranslations('onboarding.communicationStep');

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
                <div className="rounded-lg border border-border dark:border-border-dark bg-surface dark:bg-surface-dark hover:border-border-secondary dark:hover:border-white/15 transition-all">
                    <div className="flex items-start gap-3 p-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary dark:bg-white/5 text-text dark:text-text-dark">
                            <SlackMark />
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold text-text dark:text-text-dark truncate">
                                    {t('slack.name')}
                                </p>
                                <Button size="sm" variant="secondary" asChild>
                                    <Link
                                        href={`${ROUTES.DASHBOARD_PLUGINS}/slack-connector`}
                                        data-testid="onboarding-communication-connect-slack"
                                    >
                                        {t('slack.action')}
                                        <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                                    </Link>
                                </Button>
                            </div>
                            <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                                {t('slack.description')}
                            </p>
                        </div>
                    </div>
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
