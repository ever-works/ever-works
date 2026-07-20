'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useRouter } from '@/i18n/navigation';
import { ROUTES } from '@/lib/constants';
import { createTeamAction } from '@/app/actions/dashboard/teams';
import type { CreateTeamInput, Team, TeamsOrganization } from '@/lib/api/teams';

const SELECT_CLASSES =
    'w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark';

export interface TeamAgentOption {
    id: string;
    name: string;
    title: string | null;
}

export interface NewTeamDialogProps {
    org: TeamsOrganization;
    teams: Team[];
    agents: TeamAgentOption[];
}

/**
 * Teams & Prebuilt Companies §4.2 — create-team form. Raw useState per
 * field (house convention, no form library) with an explicit
 * `isSubmitting` guard for the detached-async submit. Parent team and
 * manager agent are optional native selects fed by the server page.
 */
export function NewTeamDialog({ org, teams, agents }: NewTeamDialogProps) {
    const t = useTranslations('dashboard.teamsPage');
    const router = useRouter();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const [parentTeamId, setParentTeamId] = useState('');
    const [managerAgentId, setManagerAgentId] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleSubmit = async () => {
        const trimmedName = name.trim();
        if (!trimmedName || isSubmitting) return;
        setIsSubmitting(true);
        try {
            const input: CreateTeamInput = { name: trimmedName };
            const trimmedDescription = description.trim();
            if (trimmedDescription) input.description = trimmedDescription;
            if (parentTeamId) input.parentTeamId = parentTeamId;
            if (managerAgentId) input.managerAgentId = managerAgentId;
            const team = await createTeamAction(org.id, input);
            router.push(ROUTES.DASHBOARD_TEAM(team.id));
        } catch {
            toast.error(t('errors.createFailed'));
        } finally {
            setIsSubmitting(false);
        }
    };

    return (
        <div className="max-w-xl mx-auto p-6">
            <div className="flex items-center gap-3 mb-6">
                <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                    <Users className="w-4 h-4 text-primary" strokeWidth={1.5} />
                </div>
                <div className="min-w-0 flex-1">
                    <h1 className="text-xl font-semibold text-text dark:text-text-dark">
                        {t('newDialog.title')}
                    </h1>
                </div>
                <span className="rounded-full border border-border/60 dark:border-border-dark/60 px-2.5 py-1 text-xs text-text-secondary dark:text-text-secondary-dark max-w-40 truncate">
                    {org.displayName}
                </span>
            </div>

            <div className="space-y-4">
                <Input
                    label={t('newDialog.nameLabel')}
                    variant="form"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t('newDialog.namePlaceholder')}
                    maxLength={200}
                    autoFocus
                    data-testid="team-create-name"
                />

                <Textarea
                    label={t('newDialog.descriptionLabel')}
                    variant="form"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder={t('newDialog.descriptionPlaceholder')}
                    rows={3}
                />

                <div>
                    <label
                        htmlFor="team-create-parent"
                        className="block text-xs font-medium text-text dark:text-text-dark mb-2"
                    >
                        {t('newDialog.parentLabel')}
                    </label>
                    <select
                        id="team-create-parent"
                        value={parentTeamId}
                        onChange={(event) => setParentTeamId(event.target.value)}
                        className={SELECT_CLASSES}
                        data-testid="team-create-parent"
                    >
                        <option value="">{t('newDialog.parentNone')}</option>
                        {teams.map((team) => (
                            <option key={team.id} value={team.id}>
                                {team.name}
                            </option>
                        ))}
                    </select>
                </div>

                <div>
                    <label
                        htmlFor="team-create-manager"
                        className="block text-xs font-medium text-text dark:text-text-dark mb-2"
                    >
                        {t('newDialog.managerLabel')}
                    </label>
                    <select
                        id="team-create-manager"
                        value={managerAgentId}
                        onChange={(event) => setManagerAgentId(event.target.value)}
                        className={SELECT_CLASSES}
                        data-testid="team-create-manager"
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

            <div className="flex items-center justify-between gap-2 mt-6">
                <Button variant="ghost" size="sm" onClick={() => router.back()}>
                    {t('newDialog.cancel')}
                </Button>
                <Button
                    size="sm"
                    onClick={handleSubmit}
                    disabled={!name.trim() || isSubmitting}
                    loading={isSubmitting}
                    data-testid="team-create-submit"
                >
                    {isSubmitting ? t('newDialog.creating') : t('newDialog.submit')}
                </Button>
            </div>
        </div>
    );
}
