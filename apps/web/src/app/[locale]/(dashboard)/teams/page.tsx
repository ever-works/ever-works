import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import {
    BookOpen,
    Briefcase,
    ClipboardList,
    Code,
    Megaphone,
    Network,
    Palette,
    PenLine,
    Plus,
    Rocket,
    Shield,
    Sparkles,
    TrendingUp,
    Users,
    Wrench,
    type LucideIcon,
} from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { teamsAPI, type Team } from '@/lib/api/teams';
import { PageHeader } from '@/components/common/PageHeader';
import { ROUTES } from '@/lib/constants';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.teamsPage');
    return { title: t('title') };
}

/**
 * Teams & Prebuilt Companies §4.2 — `/teams` list page. Active-org
 * resolution v1: `listOrganizations()` (already defensive), zero orgs
 * renders the create-first-org empty state, else `orgs[0]` is the
 * active org. The team list fetch is defensive (`.catch`) so a flaky
 * API renders the empty state instead of a 500.
 */

/**
 * Curated kebab-case lucide ids for `teams.avatarIcon` (same
 * convention as agent templates — AgentTemplateChips' ICON_BY_NAME).
 * Imported explicitly (not via a dynamic barrel) to keep the bundle
 * lean. Unknown names fall back to `Users`.
 */
const TEAM_ICON_BY_NAME: Record<string, LucideIcon> = {
    users: Users,
    briefcase: Briefcase,
    rocket: Rocket,
    code: Code,
    wrench: Wrench,
    'pen-line': PenLine,
    'trending-up': TrendingUp,
    sparkles: Sparkles,
    'clipboard-list': ClipboardList,
    'book-open': BookOpen,
    shield: Shield,
    megaphone: Megaphone,
    palette: Palette,
};

function resolveTeamIcon(name: string | null): LucideIcon {
    return (name && TEAM_ICON_BY_NAME[name]) || Users;
}

const PRIMARY_LINK_CLASSES =
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors h-8 px-3 text-xs bg-button-primary dark:bg-button-primary-dark hover:bg-button-primary-hover dark:hover:bg-button-primary-hover-dark text-button-primary-foreground dark:text-button-primary-foreground-dark';

const SECONDARY_LINK_CLASSES = `${PRIMARY_LINK_CLASSES} border border-border dark:border-border-dark`;

export default async function TeamsPage() {
    const t = await getTranslations('dashboard.teamsPage');
    const orgs = await teamsAPI.listOrganizations();

    if (orgs.length === 0) {
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
                    <Link href="/" className={PRIMARY_LINK_CLASSES}>
                        {t('noOrg.cta')}
                    </Link>
                </div>
            </div>
        );
    }

    const org = orgs[0];
    const teams = await teamsAPI.list(org.id).catch(() => [] as Team[]);
    const teamById = new Map(teams.map((team) => [team.id, team]));

    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            <PageHeader
                icon={Users}
                title={t('title')}
                subtitle={t('subtitle')}
                actions={
                    <>
                        <span className="rounded-full border border-border/60 dark:border-border-dark/60 px-2.5 py-1 text-xs text-text-secondary dark:text-text-secondary-dark max-w-40 truncate">
                            {org.displayName}
                        </span>
                        <Link
                            href={ROUTES.DASHBOARD_ORG_CHART}
                            data-testid="teams-org-chart-link"
                            className={SECONDARY_LINK_CLASSES}
                        >
                            <Network className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
                            {t('orgChartCta')}
                        </Link>
                        <Link
                            href={ROUTES.DASHBOARD_TEAM_NEW}
                            data-testid="teams-new-link"
                            className={PRIMARY_LINK_CLASSES}
                        >
                            <Plus className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
                            {t('newTeamCta')}
                        </Link>
                    </>
                }
            />

            {teams.length === 0 ? (
                <div
                    data-testid="teams-empty"
                    className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-10 flex flex-col items-center text-center gap-3"
                >
                    <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Users className="w-5 h-5 text-primary" strokeWidth={1.5} />
                    </div>
                    <h2 className="text-base font-semibold text-text dark:text-text-dark">
                        {t('empty.title')}
                    </h2>
                    <p className="text-sm text-text-secondary dark:text-text-secondary-dark max-w-md">
                        {t('empty.description')}
                    </p>
                    <Link href={ROUTES.DASHBOARD_TEAM_NEW} className={PRIMARY_LINK_CLASSES}>
                        <Plus className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
                        {t('empty.cta')}
                    </Link>
                </div>
            ) : (
                <div
                    data-testid="teams-list"
                    className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
                >
                    {teams.map((team) => {
                        const Icon = resolveTeamIcon(team.avatarIcon);
                        const parent = team.parentTeamId
                            ? teamById.get(team.parentTeamId)
                            : undefined;
                        return (
                            <Link
                                key={team.id}
                                href={ROUTES.DASHBOARD_TEAM(team.id)}
                                data-testid={`team-card-${team.slug}`}
                                className="group block rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 hover:border-border dark:hover:border-border-dark transition-colors"
                            >
                                <div className="flex items-start gap-3">
                                    <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                                        <Icon
                                            className="w-4 h-4 text-primary"
                                            strokeWidth={1.5}
                                            aria-hidden="true"
                                        />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <h3 className="text-sm font-semibold text-text dark:text-text-dark truncate">
                                            {team.name}
                                        </h3>
                                        {team.description ? (
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 line-clamp-2">
                                                {team.description}
                                            </p>
                                        ) : null}
                                        {parent ? (
                                            <div className="mt-3">
                                                <span className="px-1.5 py-0.5 rounded bg-surface-secondary dark:bg-surface-secondary-dark text-[11px] text-text-secondary dark:text-text-secondary-dark">
                                                    {parent.name}
                                                </span>
                                            </div>
                                        ) : null}
                                    </div>
                                </div>
                            </Link>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
