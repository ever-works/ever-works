'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
    BookOpen,
    Bot,
    Briefcase,
    ClipboardList,
    Code,
    Megaphone,
    Palette,
    PenLine,
    Rocket,
    Settings,
    Shield,
    Sparkles,
    TrendingUp,
    User,
    Users,
    Wrench,
    type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { addTeamMemberAction, removeTeamMemberAction } from '@/app/actions/dashboard/teams';
import { TeamResourcesSection, type ResourceOption } from '@/components/teams/TeamResourcesSection';
import type {
    OrgUser,
    Team,
    TeamDetail,
    TeamMemberRole,
    TeamMemberType,
    TeamMemberView,
    TeamResourcesGrouped,
    TeamsOrganization,
} from '@/lib/api/teams';

const SELECT_CLASSES =
    'w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark';

/**
 * Curated kebab-case lucide ids for `teams.avatarIcon` (same
 * convention as agent templates). Unknown names fall back to `Users`.
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

export interface TeamAgentOption {
    id: string;
    name: string;
    title: string | null;
}

export interface TeamDetailClientProps {
    org: TeamsOrganization;
    team: TeamDetail;
    /** Full org team list — parent/sub-team name resolution. */
    teams: Team[];
    /** Org Agents — add-member select + manager/member name resolution. */
    agents: TeamAgentOption[];
    /** Org people — the human half of the add-member select + name resolution. */
    users: OrgUser[];
    /** Resources (Works/Agents/…) attached to this team, grouped by type. */
    resources: TeamResourcesGrouped;
    /** Org Works available to attach in the Resources section. */
    works: ResourceOption[];
}

/**
 * Teams & Prebuilt Companies §4.2 — `/teams/[id]` overview client.
 * Header (icon, manager chip, parent link, settings), roster with
 * add/remove (Agents and people — the Type select switches which
 * directory the Who select is drawn from), and sub-team cards.
 * Mutations go through the server actions then `router.refresh()` so
 * the server payload stays the single source of truth.
 */
export function TeamDetailClient({
    org,
    team,
    teams,
    agents,
    users,
    resources,
    works,
}: TeamDetailClientProps) {
    const t = useTranslations('dashboard.teamsPage');
    const router = useRouter();
    const [memberType, setMemberType] = useState<TeamMemberType>('agent');
    const [selectedMemberId, setSelectedMemberId] = useState('');
    const [role, setRole] = useState<TeamMemberRole>('member');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);

    const Icon = resolveTeamIcon(team.avatarIcon);
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const teamById = new Map(teams.map((entry) => [entry.id, entry]));
    const manager = team.managerAgentId ? agentById.get(team.managerAgentId) : undefined;
    const parentTeam = team.parentTeamId ? teamById.get(team.parentTeamId) : undefined;
    const subTeams = team.childTeamIds
        .map((childId) => teamById.get(childId))
        .filter((entry): entry is Team => Boolean(entry));

    const userById = new Map(users.map((user) => [user.id, user]));

    /** Already on the roster, so not offerable again — the DB carries a
     *  matching UNIQUE(teamId, memberType, memberId), and an option that can
     *  only 409 is not a choice. Keyed per type: Agent ids and user ids are
     *  separate id spaces, so one shared set would hide real candidates. */
    const rosterIdsByType = (type: TeamMemberType) =>
        new Set(
            team.members
                .filter((member) => member.memberType === type)
                .map((member) => member.memberId),
        );
    const rosterAgentIds = rosterIdsByType('agent');
    const rosterUserIds = rosterIdsByType('user');
    const addableAgents = agents.filter((agent) => !rosterAgentIds.has(agent.id));
    const addableUsers = users.filter((user) => !rosterUserIds.has(user.id));

    /** What the Who select offers, for whichever directory is selected. */
    const addableOptions =
        memberType === 'agent'
            ? addableAgents.map((agent) => ({
                  id: agent.id,
                  label: agent.title ? `${agent.name} — ${agent.title}` : agent.name,
              }))
            : addableUsers.map((user) => ({
                  id: user.id,
                  // Usernames are unique, but they are not always
                  // recognisable — the email is what lets you tell which
                  // colleague this actually is. Shown when there is one.
                  label: user.email ? `${user.username} — ${user.email}` : user.username,
              }));

    const memberName = (member: TeamMemberView): string => {
        if (member.name) return member.name;
        if (member.memberType === 'agent') {
            return agentById.get(member.memberId)?.name ?? member.memberId;
        }
        // The server resolves human members to their username, so this only
        // fires when the User row is gone. Try the directory before falling
        // back to echoing a raw UUID at whoever is reading the roster.
        return userById.get(member.memberId)?.username ?? member.memberId;
    };

    const handleAdd = async () => {
        if (!selectedMemberId || isSubmitting) return;
        setIsSubmitting(true);
        try {
            await addTeamMemberAction(org.id, team.id, {
                memberType,
                memberId: selectedMemberId,
                role,
            });
            setSelectedMemberId('');
            setRole('member');
            router.refresh();
        } catch {
            toast.error(t('errors.memberAddFailed'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleRemove = async (member: TeamMemberView) => {
        if (removingMemberId) return;
        setRemovingMemberId(member.memberId);
        try {
            await removeTeamMemberAction(org.id, team.id, member.memberType, member.memberId);
            router.refresh();
        } catch {
            toast.error(t('errors.memberRemoveFailed'));
        } finally {
            setRemovingMemberId(null);
        }
    };

    return (
        <div data-testid="team-detail" className="p-6 max-w-screen-2xl mx-auto space-y-4">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Icon
                            className="w-4 h-4 text-primary"
                            strokeWidth={1.5}
                            aria-hidden="true"
                        />
                    </div>
                    <div className="min-w-0">
                        <h1 className="text-2xl font-semibold text-text dark:text-text-dark truncate">
                            {team.name}
                        </h1>
                        {team.description ? (
                            <p className="text-sm text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                                {team.description}
                            </p>
                        ) : null}
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-text-secondary dark:text-text-secondary-dark">
                            {manager ? (
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 dark:border-border-dark/60 px-2.5 py-1">
                                    <Bot
                                        className="w-3.5 h-3.5"
                                        strokeWidth={1.5}
                                        aria-hidden="true"
                                    />
                                    {t('detail.managerLabel')}: {manager.name}
                                </span>
                            ) : null}
                            {parentTeam ? (
                                <Link
                                    href={ROUTES.DASHBOARD_TEAM(parentTeam.id)}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-border/60 dark:border-border-dark/60 px-2.5 py-1 hover:border-primary transition-colors"
                                >
                                    <Users
                                        className="w-3.5 h-3.5"
                                        strokeWidth={1.5}
                                        aria-hidden="true"
                                    />
                                    {t('detail.parentLabel')}: {parentTeam.name}
                                </Link>
                            ) : null}
                        </div>
                    </div>
                </div>
                <Button
                    href={ROUTES.DASHBOARD_TEAM_SETTINGS(team.id)}
                    variant="secondary"
                    size="sm"
                    className="gap-1.5 shrink-0"
                >
                    <Settings className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
                    {t('detail.settingsTab')}
                </Button>
            </div>

            {/* Roster */}
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">
                    {t('detail.rosterTitle')}
                </h2>

                {team.members.length === 0 ? (
                    <p className="text-sm text-text-muted dark:text-text-muted-dark">
                        {t('detail.emptyRoster')}
                    </p>
                ) : (
                    <ul className="divide-y divide-border/40 dark:divide-border-dark/40">
                        {team.members.map((member) => (
                            <li key={member.id} className="flex items-center gap-3 py-2.5">
                                <div className="shrink-0 w-7 h-7 rounded-md bg-surface-secondary dark:bg-surface-secondary-dark flex items-center justify-center">
                                    {member.memberType === 'agent' ? (
                                        <Bot
                                            className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark"
                                            strokeWidth={1.5}
                                            aria-hidden="true"
                                        />
                                    ) : (
                                        <User
                                            className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark"
                                            strokeWidth={1.5}
                                            aria-hidden="true"
                                        />
                                    )}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm text-text dark:text-text-dark truncate">
                                        {memberName(member)}
                                    </div>
                                    {member.title ? (
                                        <div className="text-xs text-text-muted dark:text-text-muted-dark truncate">
                                            {member.title}
                                        </div>
                                    ) : null}
                                </div>
                                <span
                                    className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${
                                        member.role === 'lead'
                                            ? 'bg-primary/10 text-primary'
                                            : 'bg-text-muted/10 text-text-muted'
                                    }`}
                                >
                                    {member.role === 'lead'
                                        ? t('detail.roleLead')
                                        : t('detail.roleMember')}
                                </span>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleRemove(member)}
                                    loading={removingMemberId === member.memberId}
                                    disabled={removingMemberId !== null}
                                    className="text-xs text-danger hover:text-danger"
                                    data-testid={`team-member-remove-${member.memberId}`}
                                >
                                    {t('detail.removeMember')}
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}

                {/* Add member */}
                <div className="border-t border-border/40 dark:border-border-dark/40 pt-4">
                    <h3 className="text-xs font-medium text-text dark:text-text-dark mb-2">
                        {t('detail.addMemberCta')}
                    </h3>
                    <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                        <div className="sm:w-32">
                            <label
                                htmlFor="team-member-type"
                                className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                            >
                                {t('detail.addMemberTypeLabel')}
                            </label>
                            <select
                                id="team-member-type"
                                value={memberType}
                                onChange={(event) => {
                                    setMemberType(event.target.value as TeamMemberType);
                                    // Agent ids and user ids are separate id
                                    // spaces. Carrying the old selection across
                                    // a type switch would post an Agent id as a
                                    // user — a 404 the user cannot explain.
                                    setSelectedMemberId('');
                                }}
                                className={SELECT_CLASSES}
                            >
                                <option value="agent">{t('detail.addMemberAgent')}</option>
                                <option value="user">{t('detail.addMemberUser')}</option>
                            </select>
                        </div>
                        <div className="flex-1 min-w-0">
                            <label
                                htmlFor="team-member-select"
                                className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                            >
                                {t('detail.addMemberSelectLabel')}
                            </label>
                            <select
                                id="team-member-select"
                                value={selectedMemberId}
                                onChange={(event) => setSelectedMemberId(event.target.value)}
                                className={SELECT_CLASSES}
                            >
                                <option value="">{t('detail.addMemberSelectLabel')}</option>
                                {addableOptions.map((option) => (
                                    <option key={option.id} value={option.id}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="sm:w-32">
                            <select
                                value={role}
                                onChange={(event) => setRole(event.target.value as TeamMemberRole)}
                                className={SELECT_CLASSES}
                                aria-label={t('detail.roleMember')}
                            >
                                <option value="member">{t('detail.roleMember')}</option>
                                <option value="lead">{t('detail.roleLead')}</option>
                            </select>
                        </div>
                        <Button
                            size="sm"
                            onClick={handleAdd}
                            disabled={!selectedMemberId || isSubmitting}
                            loading={isSubmitting}
                            data-testid="team-member-add"
                            className="shrink-0"
                        >
                            {isSubmitting ? t('detail.adding') : t('detail.addMemberSubmit')}
                        </Button>
                    </div>
                </div>
            </section>

            {/* Resources (Works/Agents/Missions/Ideas/Tasks that belong to this team) */}
            <TeamResourcesSection
                org={org}
                teamId={team.id}
                resources={resources}
                works={works}
                agents={agents.map((agent) => ({
                    id: agent.id,
                    name: agent.name,
                    subtitle: agent.title,
                }))}
            />

            {/* Sub-teams */}
            {subTeams.length > 0 ? (
                <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5">
                    <h2 className="text-sm font-medium text-text dark:text-text-dark mb-3">
                        {t('detail.subTeamsTitle')}
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                        {subTeams.map((subTeam) => {
                            const SubIcon = resolveTeamIcon(subTeam.avatarIcon);
                            return (
                                <Link
                                    key={subTeam.id}
                                    href={ROUTES.DASHBOARD_TEAM(subTeam.id)}
                                    className="group flex items-start gap-3 rounded-lg border border-border/60 dark:border-border-dark/60 p-3 hover:border-primary transition-colors"
                                >
                                    <div className="shrink-0 w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                                        <SubIcon
                                            className="w-3.5 h-3.5 text-primary"
                                            strokeWidth={1.5}
                                            aria-hidden="true"
                                        />
                                    </div>
                                    <div className="min-w-0">
                                        <div className="text-sm font-medium text-text dark:text-text-dark truncate">
                                            {subTeam.name}
                                        </div>
                                        {subTeam.description ? (
                                            <div className="text-xs text-text-muted dark:text-text-muted-dark line-clamp-2 mt-0.5">
                                                {subTeam.description}
                                            </div>
                                        ) : null}
                                    </div>
                                </Link>
                            );
                        })}
                    </div>
                </section>
            ) : null}
        </div>
    );
}
