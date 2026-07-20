import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Building2 } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { teamsAPI, type TeamsOrganization } from '@/lib/api/teams';
import { OrgChartClient } from '@/components/teams/OrgChartClient';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.orgChartPage');
    return { title: t('title') };
}

/**
 * Teams & Prebuilt Companies — `/teams/org-chart`
 * (`docs/specs/features/teams-and-companies/spec.md` §4.2, §5).
 *
 * Server page. Active-org resolution v1: `orgs[0]` from the user's
 * Tenant; zero orgs renders the no-org state (the CTA links to the
 * dashboard where the org switcher lives). Fetches are defensive —
 * `listOrganizations`/`orgChart` already swallow API errors into
 * `[]`/`null` — so a flaky API degrades to the empty states instead
 * of a 500.
 */
export default async function OrgChartPage() {
    const t = await getTranslations('dashboard.orgChartPage');
    const orgs: TeamsOrganization[] = await teamsAPI.listOrganizations().catch(() => []);

    if (orgs.length === 0) {
        const tTeams = await getTranslations('dashboard.teamsPage');
        return (
            <div
                data-testid="org-chart-no-org"
                className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-border/60 dark:border-border-dark/60 px-6 py-16 text-center"
            >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-info/20 bg-info/10">
                    <Building2 className="h-5 w-5 text-info" strokeWidth={1.5} />
                </div>
                <p className="max-w-md text-sm text-text-secondary dark:text-text-secondary-dark">
                    {t('noOrg')}
                </p>
                <Link
                    href={ROUTES.DASHBOARD}
                    className="rounded-md border border-border dark:border-border-dark px-3 py-1.5 text-sm text-text dark:text-text-dark transition-colors hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
                >
                    {tTeams('noOrg.cta')}
                </Link>
            </div>
        );
    }

    const org = orgs[0];
    const payload = await teamsAPI.orgChart(org.id);
    const isEmpty = !payload || (payload.teams.length === 0 && payload.agents.length === 0);

    return (
        <div className="w-full space-y-5">
            <Link href={ROUTES.DASHBOARD_TEAMS} className="text-xs text-text-muted hover:text-text">
                ← {t('backToTeams')}
            </Link>
            <div>
                <h1 className="text-2xl font-semibold text-text dark:text-text-dark">
                    {t('title')}
                </h1>
                <p className="mt-1 text-sm text-text-secondary dark:text-text-secondary-dark">
                    {org.displayName} — {t('subtitle')}
                </p>
            </div>
            {isEmpty ? (
                <div
                    data-testid="org-chart-empty"
                    className="rounded-xl border border-dashed border-border/60 dark:border-border-dark/60 px-6 py-16 text-center"
                >
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark">
                        {t('empty')}
                    </p>
                </div>
            ) : (
                <OrgChartClient payload={payload} />
            )}
        </div>
    );
}
