'use client';

import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PluginIcon } from '@/components/plugins/PluginIcon';
import { Link } from '@/i18n/navigation';
import { OnboardingPluginStep } from '../OnboardingPluginStep';
import { ROUTES } from '@/lib/constants';
import { cn } from '@/lib/utils/cn';
import type {
    OnboardingPluginCard,
} from '@ever-works/contracts/api';
import type { UserPlugin } from '@/lib/api/plugins';

export interface PluginsCatalogStepProps {
    readonly cards: ReadonlyArray<OnboardingPluginCard>;
    readonly pluginsById: Record<string, UserPlugin | undefined>;
    readonly onExpand: (pluginId: string) => void;
}

/**
 * "Plugins & Integrations" step (step 8). Renders a scrollable grid of
 * power-user integrations (make.com, sim-ai, zapier, activepieces...) so
 * users discover them without being forced to configure them. The footer
 * makes "Skip — set up later" prominent because 99% of new users won't
 * recognise these names yet.
 */
export function PluginsCatalogStep({
    cards,
    pluginsById,
    onExpand,
}: PluginsCatalogStepProps) {
    const [openId, setOpenId] = useState<string | null>(null);

    return (
        <div className="space-y-5 max-w-3xl">
            <header>
                <h3 className="text-lg font-semibold text-text dark:text-text-dark">
                    Power-user integrations
                </h3>
                <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                    Most people skip this. You can wire any of these later from{' '}
                    <Link
                        href={ROUTES.DASHBOARD_PLUGINS}
                        className="underline hover:text-primary"
                    >
                        Settings → Plugins
                    </Link>
                    . Click a card if you want a peek now.
                </p>
            </header>

            {cards.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border dark:border-border-dark p-6 text-center text-sm text-text-muted dark:text-text-muted-dark">
                    No additional integrations available right now.
                </div>
            ) : (
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                    {cards.map((card) => {
                        const plugin = pluginsById[card.pluginId];
                        const expanded = openId === card.pluginId;
                        return (
                            <div
                                key={card.pluginId}
                                className={cn(
                                    'rounded-lg border bg-surface dark:bg-surface-dark transition-all',
                                    expanded
                                        ? 'border-primary/40 shadow-sm'
                                        : 'border-border dark:border-border-dark hover:border-border-secondary dark:hover:border-white/15',
                                )}
                            >
                                <div className="flex items-start gap-3 p-3">
                                    {plugin?.icon ? (
                                        <PluginIcon
                                            icon={plugin.icon}
                                            name={plugin.name}
                                            size={36}
                                            className="rounded-lg shrink-0"
                                        />
                                    ) : (
                                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-secondary dark:bg-white/5">
                                            <Settings2 className="h-4 w-4 text-text-muted dark:text-text-muted-dark" />
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center justify-between gap-2">
                                            <p className="text-sm font-semibold text-text dark:text-text-dark truncate">
                                                {card.name}
                                            </p>
                                            <Button
                                                size="sm"
                                                variant={expanded ? 'ghost' : 'secondary'}
                                                onClick={() => {
                                                    const next = expanded ? null : card.pluginId;
                                                    setOpenId(next);
                                                    if (!expanded) onExpand(card.pluginId);
                                                }}
                                            >
                                                {expanded ? 'Close' : 'Configure'}
                                            </Button>
                                        </div>
                                        <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark leading-relaxed">
                                            {card.description}
                                        </p>
                                    </div>
                                </div>
                                {expanded && plugin ? (
                                    <div className="border-t border-border dark:border-border-dark px-4 py-3">
                                        <OnboardingPluginStep plugin={plugin} />
                                    </div>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
