import '@/components/fleet/modules/server';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { ArrowLeft, Clock } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { readFleetFeatureFlags } from '@/lib/fleet-flags';
import { FLEET_FEATURE_FLAGS, resolveSessionPage } from '@/components/fleet/registry';
import { FLEET_PROGRAM_TRACKER_URL } from '@/components/fleet/fleet-links';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('fleet.hub');
    return { title: `${t('tabs.sessions')} · ${t('title')}` };
}

/**
 * Fleet hub (FL-01, CONTRACTS §11.1) — `/fleet/sessions/[id]`, one session's
 * page. FL-01 owns the route and its constant (`DASHBOARD_FLEET_SESSION`);
 * FL-04 fills it with `registerSessionPage`. Until then it says so — never a
 * blank page — with the way back to the hub's Sessions tab.
 */
export default async function FleetSessionPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const flags = readFleetFeatureFlags(FLEET_FEATURE_FLAGS);
    const state = resolveSessionPage(flags);
    if (state.kind === 'ready') {
        const { default: Page } = await state.load();
        return <Page sessionId={id} flags={flags} />;
    }

    const t = await getTranslations('fleet');
    return (
        <div className="w-full space-y-6" data-testid="fleet-session-page">
            <Link
                href={ROUTES.DASHBOARD_FLEET_SESSIONS}
                className="inline-flex items-center gap-1 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
            >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                {t('hub.tabs.sessions')}
            </Link>
            <div
                role="status"
                data-testid="fleet-session-placeholder"
                data-state={state.kind}
                className="rounded-xl border border-dashed border-border dark:border-border-dark p-10 flex flex-col items-center text-center gap-3"
            >
                <Clock
                    className="w-5 h-5 text-text-muted dark:text-text-muted-dark"
                    aria-hidden="true"
                />
                {state.kind === 'switched-off' ? (
                    <p className="text-sm font-medium text-text dark:text-text-dark">
                        {t('placeholder.sessions.switchedOff')}
                    </p>
                ) : (
                    <>
                        <p className="text-sm font-medium text-text dark:text-text-dark">
                            {t('placeholder.session.title', {
                                epic: state.kind === 'not-shipped' ? state.epic : 'FL-04',
                            })}
                        </p>
                        <p className="text-sm text-text-muted dark:text-text-muted-dark max-w-md">
                            {t('placeholder.session.body')}
                        </p>
                        <a
                            href={FLEET_PROGRAM_TRACKER_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-info hover:underline"
                        >
                            {t('placeholder.tracker')}
                        </a>
                    </>
                )}
            </div>
        </div>
    );
}
