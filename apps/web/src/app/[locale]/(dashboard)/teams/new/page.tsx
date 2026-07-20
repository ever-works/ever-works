import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Users } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { teamsAPI, type Team } from '@/lib/api/teams';
import { agentsAPI, type Agent } from '@/lib/api/agents';
import { NewTeamDialog } from '@/components/teams/NewTeamDialog';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.teamsPage.newDialog');
    return { title: t('title') };
}

/**
 * Teams & Prebuilt Companies §4.2 — `/teams/new`. Server-fetches the
 * active org's team list (parent-team select) and the Agent list
 * (manager select) so the dialog can offer both pickers without extra
 * round-trips. Both fetches are defensive (`.catch(() => [])`) so a
 * flaky API renders an option-less select instead of a 500.
 */
export default async function NewTeamPage() {
    const orgs = await teamsAPI.listOrganizations();

    if (orgs.length === 0) {
        const t = await getTranslations('dashboard.teamsPage');
        return (
            <div className="p-6 max-w-screen-2xl mx-auto">
                <div
                    data-testid="teams-no-org"
                    className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-10 flex flex-col items-center text-center gap-3"
                >
                    <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Users className="w-5 h-5 text-primary" strokeWidth={1.5} />
                    </div>
                    <h2 className="text-base font-semibold text-text dark:text-text-dark">
                        {t('noOrg.title')}
                    </h2>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-md">
                        {t('noOrg.description')}
                    </p>
                    <Link
                        href="/"
                        className="inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors h-8 px-3 text-xs bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark"
                    >
                        {t('noOrg.cta')}
                    </Link>
                </div>
            </div>
        );
    }

    const org = orgs[0];
    const [teams, agentsResp] = await Promise.all([
        teamsAPI.list(org.id).catch(() => [] as Team[]),
        agentsAPI.list({ limit: 100 }).catch(() => ({
            data: [] as Agent[],
            meta: { total: 0, limit: 100, offset: 0 },
        })),
    ]);

    const agents = agentsResp.data.map((agent) => ({
        id: agent.id,
        name: agent.name,
        title: agent.title,
    }));

    return <NewTeamDialog org={org} teams={teams} agents={agents} />;
}
