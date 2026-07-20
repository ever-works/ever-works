'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Save, Settings, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { deleteTeamAction, updateTeamAction } from '@/app/actions/dashboard/teams';
import type { Team, TeamDetail, TeamsOrganization, UpdateTeamInput } from '@/lib/api/teams';

const SELECT_CLASSES =
    'w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark';

export interface TeamAgentOption {
    id: string;
    name: string;
    title: string | null;
}

export interface TeamSettingsClientProps {
    org: TeamsOrganization;
    team: TeamDetail;
    /** Full org team list — re-parent select (self + descendants excluded). */
    teams: Team[];
    /** Org Agents — manager select. */
    agents: TeamAgentOption[];
}

/**
 * Teams & Prebuilt Companies §4.2 — `/teams/[id]/settings` client.
 * Raw useState per field with explicit `isSubmitting`/`isDeleting`
 * guards (house convention). The parent select excludes the team
 * itself and its descendants (best-effort client-side walk over the
 * `parentTeamId` graph); the service re-checks cycles authoritatively.
 */
export function TeamSettingsClient({ org, team, teams, agents }: TeamSettingsClientProps) {
    const t = useTranslations('dashboard.teamsPage');
    const router = useRouter();
    const [name, setName] = useState(team.name);
    const [description, setDescription] = useState(team.description ?? '');
    const [parentTeamId, setParentTeamId] = useState(team.parentTeamId ?? '');
    const [managerAgentId, setManagerAgentId] = useState(team.managerAgentId ?? '');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);

    // Exclude self + descendants from the re-parent options so the UI
    // can't ask the API for an obvious cycle. BFS over the flat
    // parentTeamId graph (visited-guard so a corrupt cycle can't loop).
    const excludedIds = useMemo(() => {
        const childrenByParent = new Map<string, string[]>();
        for (const entry of teams) {
            if (!entry.parentTeamId) continue;
            const bucket = childrenByParent.get(entry.parentTeamId);
            if (bucket) {
                bucket.push(entry.id);
            } else {
                childrenByParent.set(entry.parentTeamId, [entry.id]);
            }
        }
        const excluded = new Set<string>([team.id]);
        const queue = [team.id];
        while (queue.length > 0) {
            const current = queue.shift() as string;
            for (const childId of childrenByParent.get(current) ?? []) {
                if (!excluded.has(childId)) {
                    excluded.add(childId);
                    queue.push(childId);
                }
            }
        }
        return excluded;
    }, [teams, team.id]);

    const parentOptions = teams.filter((entry) => !excludedIds.has(entry.id));

    const handleSave = async () => {
        const trimmedName = name.trim();
        if (!trimmedName || isSubmitting) return;
        setIsSubmitting(true);
        try {
            const input: UpdateTeamInput = {
                name: trimmedName,
                description: description.trim() ? description.trim() : null,
                parentTeamId: parentTeamId ? parentTeamId : null,
                managerAgentId: managerAgentId ? managerAgentId : null,
            };
            await updateTeamAction(org.id, team.id, input);
            toast.success(t('settings.saved'));
            router.refresh();
        } catch {
            toast.error(t('errors.updateFailed'));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleDelete = async () => {
        if (isDeleting) return;
        const confirmed = window.confirm(t('settings.deleteConfirm'));
        if (!confirmed) return;
        setIsDeleting(true);
        try {
            await deleteTeamAction(org.id, team.id);
            router.push(ROUTES.DASHBOARD_TEAMS);
        } catch {
            toast.error(t('errors.deleteFailed'));
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Settings
                            className="w-4 h-4 text-primary"
                            strokeWidth={1.5}
                            aria-hidden="true"
                        />
                    </div>
                    <div>
                        <h1 className="text-sm font-medium text-text dark:text-text-dark">
                            {t('settings.title')}
                        </h1>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark font-mono">
                            {team.slug}
                        </p>
                    </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    <Input
                        label={t('settings.nameLabel')}
                        variant="form"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={200}
                    />
                    <div>
                        <label
                            htmlFor="team-settings-manager"
                            className="block text-xs font-medium text-text dark:text-text-dark mb-2"
                        >
                            {t('settings.managerLabel')}
                        </label>
                        <select
                            id="team-settings-manager"
                            value={managerAgentId}
                            onChange={(event) => setManagerAgentId(event.target.value)}
                            className={SELECT_CLASSES}
                        >
                            <option value="">{t('newDialog.managerNone')}</option>
                            {agents.map((agent) => (
                                <option key={agent.id} value={agent.id}>
                                    {agent.title ? `${agent.name} — ${agent.title}` : agent.name}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>

                <Textarea
                    label={t('settings.descriptionLabel')}
                    variant="form"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={3}
                />

                <div>
                    <label
                        htmlFor="team-settings-parent"
                        className="block text-xs font-medium text-text dark:text-text-dark mb-2"
                    >
                        {t('settings.parentLabel')}
                    </label>
                    <select
                        id="team-settings-parent"
                        value={parentTeamId}
                        onChange={(event) => setParentTeamId(event.target.value)}
                        className={SELECT_CLASSES}
                    >
                        <option value="">{t('newDialog.parentNone')}</option>
                        {parentOptions.map((entry) => (
                            <option key={entry.id} value={entry.id}>
                                {entry.name}
                            </option>
                        ))}
                    </select>
                </div>

                <div className="flex justify-end">
                    <Button
                        size="sm"
                        onClick={handleSave}
                        disabled={!name.trim() || isSubmitting}
                        loading={isSubmitting}
                        data-testid="team-settings-save"
                        className="gap-1.5"
                    >
                        <Save className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
                        {isSubmitting ? t('settings.saving') : t('settings.save')}
                    </Button>
                </div>
            </section>

            {/* Danger zone */}
            <section className="rounded-xl border border-danger/30 bg-card dark:bg-card-primary-dark p-5">
                <h2 className="text-sm font-medium text-danger">{t('settings.deleteTitle')}</h2>
                <p className="text-xs text-text-secondary dark:text-text-secondary-dark mt-1 max-w-2xl">
                    {t('settings.deleteDescription')}
                </p>
                <div className="mt-4">
                    <Button
                        variant="danger"
                        size="sm"
                        onClick={handleDelete}
                        loading={isDeleting}
                        data-testid="team-settings-delete"
                        className="gap-1.5"
                    >
                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} aria-hidden="true" />
                        {isDeleting ? t('settings.deleting') : t('settings.deleteCta')}
                    </Button>
                </div>
            </section>
        </div>
    );
}
