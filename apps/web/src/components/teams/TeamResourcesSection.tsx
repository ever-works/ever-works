'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Briefcase, Lightbulb, ListChecks, Target, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Link, useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import {
    attachTeamResourceAction,
    detachTeamResourceAction,
} from '@/app/actions/dashboard/teams';
import type {
    TeamResourceItem,
    TeamResourcesGrouped,
    TeamResourceType,
    TeamsOrganization,
} from '@/lib/api/teams';

const SELECT_CLASSES =
    'w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark';

/** The resource types the add-form can attach (searchable over org works/agents). */
type AddableType = Extract<TeamResourceType, 'work' | 'agent'>;

export interface ResourceOption {
    id: string;
    name: string;
    /** Agent title / secondary label (optional). */
    subtitle?: string | null;
}

export interface TeamResourcesSectionProps {
    org: TeamsOrganization;
    teamId: string;
    resources: TeamResourcesGrouped;
    /** Org Works available to attach. */
    works: ResourceOption[];
    /** Org Agents available to attach. */
    agents: ResourceOption[];
}

const GROUP_ORDER: TeamResourceType[] = ['work', 'agent', 'mission', 'idea', 'task'];

const GROUP_ICON: Record<TeamResourceType, LucideIcon> = {
    work: Briefcase,
    agent: Bot,
    mission: Target,
    idea: Lightbulb,
    task: ListChecks
};

function resourceHref(type: TeamResourceType, id: string): string {
    switch (type) {
        case 'work':
            return ROUTES.DASHBOARD_WORK(id);
        case 'agent':
            return ROUTES.DASHBOARD_AGENT(id);
        case 'mission':
            return ROUTES.DASHBOARD_MISSION(id);
        case 'idea':
            return ROUTES.DASHBOARD_IDEA(id);
        case 'task':
            return ROUTES.DASHBOARD_TASK(id);
    }
}

/**
 * Teams & Prebuilt Companies — Team detail "Resources" section. Lists the
 * Works / Agents / Missions / Ideas / Tasks attached to this team (grouped,
 * each linking to its detail page with a remove control) and an add form: a
 * type toggle (Work | Agent) + a searchable select of the org's resources.
 * Mutations run through the server actions then `router.refresh()` so the
 * server payload stays the single source of truth.
 */
export function TeamResourcesSection({
    org,
    teamId,
    resources,
    works,
    agents
}: TeamResourcesSectionProps) {
    const t = useTranslations('dashboard.teamsPage');
    const router = useRouter();
    const [addType, setAddType] = useState<AddableType>('work');
    const [search, setSearch] = useState('');
    const [selectedId, setSelectedId] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [removingId, setRemovingId] = useState<string | null>(null);

    const allItems = useMemo(
        () => GROUP_ORDER.flatMap((type) => resources[type]),
        [resources],
    );
    const hasAny = allItems.length > 0;

    // Ids already attached (per type) — filtered out of the add options.
    const attachedByType = useMemo(() => {
        const map: Record<AddableType, Set<string>> = { work: new Set(), agent: new Set() };
        for (const item of resources.work) map.work.add(item.resourceId);
        for (const item of resources.agent) map.agent.add(item.resourceId);
        return map;
    }, [resources]);

    const options = useMemo(() => {
        const source = addType === 'work' ? works : agents;
        const attached = attachedByType[addType];
        const q = search.trim().toLowerCase();
        return source
            .filter((option) => !attached.has(option.id))
            .filter((option) =>
                q
                    ? option.name.toLowerCase().includes(q) ||
                      (option.subtitle ?? '').toLowerCase().includes(q)
                    : true,
            );
    }, [addType, works, agents, attachedByType, search]);

    const handleTypeChange = (next: AddableType) => {
        setAddType(next);
        setSelectedId('');
        setSearch('');
    };

    const handleAttach = async () => {
        if (!selectedId || isSubmitting) return;
        setIsSubmitting(true);
        try {
            await attachTeamResourceAction(org.id, teamId, {
                resourceType: addType,
                resourceId: selectedId
            });
            setSelectedId('');
            setSearch('');
            router.refresh();
        } catch {
            toast.error(t('errors.resourceAttachFailed'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleRemove = async (item: TeamResourceItem) => {
        if (removingId) return;
        setRemovingId(item.id);
        try {
            await detachTeamResourceAction(org.id, teamId, item.resourceType, item.resourceId);
            router.refresh();
        } catch {
            toast.error(t('errors.resourceDetachFailed'));
        } finally {
            setRemovingId(null);
        }
    };

    const groupLabel = (type: TeamResourceType): string => {
        switch (type) {
            case 'work':
                return t('detail.resourceGroupWork');
            case 'agent':
                return t('detail.resourceGroupAgent');
            case 'mission':
                return t('detail.resourceGroupMission');
            case 'idea':
                return t('detail.resourceGroupIdea');
            case 'task':
                return t('detail.resourceGroupTask');
        }
    };

    return (
        <section
            data-testid="team-resources"
            className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4"
        >
            <div>
                <h2 className="text-sm font-medium text-text dark:text-text-dark">
                    {t('detail.resourcesTitle')}
                </h2>
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark mt-0.5">
                    {t('detail.resourcesSubtitle')}
                </p>
            </div>

            {!hasAny ? (
                <p className="text-sm text-text-muted dark:text-text-muted-dark">
                    {t('detail.emptyResources')}
                </p>
            ) : (
                <div className="space-y-4">
                    {GROUP_ORDER.filter((type) => resources[type].length > 0).map((type) => {
                        const GroupIcon = GROUP_ICON[type];
                        return (
                            <div key={type}>
                                <h3 className="text-xs font-medium uppercase tracking-wide text-text-secondary dark:text-text-secondary-dark mb-2">
                                    {groupLabel(type)}
                                </h3>
                                <ul className="divide-y divide-border/40 dark:divide-border-dark/40">
                                    {resources[type].map((item) => (
                                        <li
                                            key={item.id}
                                            data-testid={`team-resource-${item.resourceId}`}
                                            className="flex items-center gap-3 py-2.5"
                                        >
                                            <div className="shrink-0 w-7 h-7 rounded-md bg-surface-secondary dark:bg-surface-secondary-dark flex items-center justify-center">
                                                <GroupIcon
                                                    className="w-3.5 h-3.5 text-text-secondary dark:text-text-secondary-dark"
                                                    strokeWidth={1.5}
                                                    aria-hidden="true"
                                                />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <Link
                                                    href={resourceHref(item.resourceType, item.resourceId)}
                                                    className="text-sm text-text dark:text-text-dark truncate hover:text-primary transition-colors block"
                                                >
                                                    {item.name ?? item.resourceId}
                                                </Link>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleRemove(item)}
                                                loading={removingId === item.id}
                                                disabled={removingId !== null}
                                                className="text-xs text-danger hover:text-danger"
                                                data-testid={`team-resource-remove-${item.resourceId}`}
                                            >
                                                {t('detail.removeResource')}
                                            </Button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Attach a resource */}
            <div
                data-testid="team-resource-add"
                className="border-t border-border/40 dark:border-border-dark/40 pt-4"
            >
                <h3 className="text-xs font-medium text-text dark:text-text-dark mb-2">
                    {t('detail.addResourceCta')}
                </h3>
                <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
                    <div className="sm:w-32">
                        <label
                            htmlFor="team-resource-type"
                            className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                        >
                            {t('detail.addResourceTypeLabel')}
                        </label>
                        <select
                            id="team-resource-type"
                            value={addType}
                            onChange={(event) => handleTypeChange(event.target.value as AddableType)}
                            className={SELECT_CLASSES}
                        >
                            <option value="work">{t('detail.resourceTypeWork')}</option>
                            <option value="agent">{t('detail.resourceTypeAgent')}</option>
                        </select>
                    </div>
                    <div className="flex-1 min-w-0">
                        <label
                            htmlFor="team-resource-select"
                            className="block text-xs text-text-secondary dark:text-text-secondary-dark mb-1"
                        >
                            {t('detail.addResourceSelectLabel')}
                        </label>
                        <input
                            type="text"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder={t('detail.addResourceSearchPlaceholder')}
                            className={`${SELECT_CLASSES} mb-2`}
                            aria-label={t('detail.addResourceSearchPlaceholder')}
                            data-testid="team-resource-search"
                        />
                        <select
                            id="team-resource-select"
                            value={selectedId}
                            onChange={(event) => setSelectedId(event.target.value)}
                            className={SELECT_CLASSES}
                        >
                            <option value="">{t('detail.addResourceSelectLabel')}</option>
                            {options.map((option) => (
                                <option key={option.id} value={option.id}>
                                    {option.subtitle
                                        ? `${option.name} — ${option.subtitle}`
                                        : option.name}
                                </option>
                            ))}
                        </select>
                    </div>
                    <Button
                        size="sm"
                        onClick={handleAttach}
                        disabled={!selectedId || isSubmitting}
                        loading={isSubmitting}
                        data-testid="team-resource-add-submit"
                        className="shrink-0"
                    >
                        {isSubmitting ? t('detail.attaching') : t('detail.addResourceSubmit')}
                    </Button>
                </div>
            </div>
        </section>
    );
}
