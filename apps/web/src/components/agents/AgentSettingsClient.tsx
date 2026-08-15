'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import {
    Archive,
    ArchiveRestore,
    Building2,
    Cpu,
    IdCard,
    Pause,
    Play,
    Save,
    ShieldCheck,
    Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useRouter } from '@/i18n/navigation';
import {
    pauseAgentAction,
    resumeAgentAction,
    unarchiveAgentAction,
    updateAgentAction,
} from '@/app/actions/agents';
// Teams & Companies spec §4.3 — roster mutations for the Organization
// card's Team select (v1 UI: one team per Agent).
import { addTeamMemberAction, removeTeamMemberAction } from '@/app/actions/dashboard/teams';
import { AgentScorecardCard } from '@/components/agents/AgentScorecardCard';
import { ArchiveAgentDialog } from '@/components/agents/ArchiveAgentDialog';
import { DeleteAgentDialog } from '@/components/agents/DeleteAgentDialog';
import { MergePolicyCard } from '@/components/policy/MergePolicyCard';
import type { MergePolicyOverride } from '@ever-works/contracts';
import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select';
import { PluginModelSelect } from '@/components/plugins/form/PluginModelSelect';
import type { Agent, AgentIdleBehavior, AgentPermissions } from '@/lib/api/agents';

const permissionLabels: Array<{ key: keyof AgentPermissions; label: string }> = [
    { key: 'canCreateAgents', label: 'Create agents' },
    { key: 'canAssignTasks', label: 'Assign tasks' },
    { key: 'canEditSkills', label: 'Edit skills' },
    { key: 'canEditAgentFiles', label: 'Edit instructions' },
    { key: 'canSpend', label: 'Spend budget' },
    { key: 'canCommitToRepo', label: 'Commit to repo' },
    { key: 'canOpenPullRequests', label: 'Open pull requests' },
    { key: 'canCallExternalTools', label: 'Call external tools' },
];

const idleBehaviorOptions: Array<{ value: AgentIdleBehavior; label: string }> = [
    { value: 'propose', label: 'Propose work' },
    { value: 'sleep', label: 'Sleep' },
    { value: 'self-improve', label: 'Self improve' },
];

/**
 * Teams & Companies spec §4.3 — server-computed context for the
 * optional Organization card. `currentTeamIds` comes from the org
 * chart payload (this agent's roster memberships); the v1 UI edits
 * ONE team (the first membership). Absent → the card isn't rendered.
 */
export interface AgentSettingsOrganization {
    activeOrgId: string;
    teams: Array<{ id: string; label: string }>;
    currentTeamIds: string[];
    agentOptions: Array<{ id: string; label: string }>;
}

/**
 * Common heartbeat cadences, offered as presets.
 *
 * The field accepts any cron expression, so this is a shortcut list rather
 * than an enumeration — `allowCustom` keeps arbitrary crons reachable.
 */
const heartbeatCadenceOptions: SearchableSelectOption[] = [
    { value: 'manual', label: 'Manual', description: 'Only runs when you trigger it' },
    { value: '0 * * * *', label: 'Hourly', description: '0 * * * *' },
    { value: '0 */6 * * *', label: 'Every 6 hours', description: '0 */6 * * *' },
    { value: '0 9 * * *', label: 'Daily at 09:00', description: '0 9 * * *' },
    { value: '0 9 * * 1', label: 'Weekly on Monday', description: '0 9 * * 1' },
    { value: '0 9 1 * *', label: 'Monthly on the 1st', description: '0 9 1 * *' },
];

interface AgentSettingsClientProps {
    agent: Agent;
    organization?: AgentSettingsOrganization;
    /**
     * AI provider plugins available to this user, for the Runtime picker.
     * Empty when the plugins API is unreachable — the picker still renders
     * and still accepts a typed provider id, so a flaky call degrades the
     * affordance rather than blocking the page.
     */
    aiProviders?: Array<{ id: string; name: string; category?: string }>;
    /**
     * Environments (Settings → Environments) — the user's PUBLISHED
     * Environments for the Runtime picker (the server enforces the
     * published-only rule; this list is the matching UI filter). Empty
     * when the API is unreachable — the picker still renders with
     * "None (default)" plus the currently-assigned id, so a flaky call
     * degrades the affordance rather than blocking the page.
     */
    environments?: Array<{ id: string; name: string }>;
}

export function AgentSettingsClient({
    agent: initialAgent,
    organization,
    aiProviders = [],
    environments = [],
}: AgentSettingsClientProps) {
    const router = useRouter();
    const aiProviderOptions = useMemo<SearchableSelectOption[]>(
        () =>
            aiProviders.map((provider) => ({
                value: provider.id,
                label: provider.name,
                description: provider.id,
            })),
        [aiProviders],
    );
    const environmentOptions = useMemo<SearchableSelectOption[]>(
        () =>
            environments.map((environment) => ({
                value: environment.id,
                label: environment.name,
            })),
        [environments],
    );
    const [agent, setAgent] = useState(initialAgent);
    const [isSaving, startSaving] = useTransition();
    const [isChangingStatus, startChangingStatus] = useTransition();
    const [name, setName] = useState(agent.name);
    const [title, setTitle] = useState(agent.title ?? '');
    const [capabilities, setCapabilities] = useState(agent.capabilities ?? '');
    const [aiProviderId, setAiProviderId] = useState(agent.aiProviderId ?? '');
    const [modelId, setModelId] = useState(agent.modelId ?? '');
    const [environmentId, setEnvironmentId] = useState(agent.environmentId ?? '');
    const [heartbeatCadence, setHeartbeatCadence] = useState(agent.heartbeatCadence ?? 'manual');
    const [idleBehavior, setIdleBehavior] = useState<AgentIdleBehavior>(agent.idleBehavior);
    const [maxSkillContextTokens, setMaxSkillContextTokens] = useState(
        String(agent.maxSkillContextTokens),
    );
    const [pauseAfterFailures, setPauseAfterFailures] = useState(String(agent.pauseAfterFailures));
    const [permissions, setPermissions] = useState<AgentPermissions>(agent.permissions);
    // Both terminal actions in the Identity header confirm through a
    // dialog rather than `window.confirm`: archive because it takes the
    // Agent out of the catalog, delete because it is the one
    // irreversible action on this page.
    const tIdentity = useTranslations('dashboard.agentsPage.settings.identity');
    // Restore borrows the Archived tab's strings rather than minting a
    // second set: it is literally the same action, and reading
    // differently in the two places it can be triggered from would be
    // the bug, not the reuse.
    const tArchived = useTranslations('dashboard.agentsPage.archived');
    const [isArchiveOpen, setIsArchiveOpen] = useState(false);
    const [isDeleteOpen, setIsDeleteOpen] = useState(false);

    // Teams & Companies spec §4.3 — Organization card state. Explicit
    // isSubmitting (house rule for detached-async submits), '' = none.
    const tOrg = useTranslations('dashboard.agentsPage.settings.orgCard');
    const [teamId, setTeamId] = useState(organization?.currentTeamIds[0] ?? '');
    // ALL current memberships — the select is single-team by design (v1),
    // but an agent may hold several roster rows (imports, API); saving
    // consolidates onto the selection (PR #1647 review).
    const [savedTeamIds, setSavedTeamIds] = useState<string[]>(organization?.currentTeamIds ?? []);
    const [reportsToId, setReportsToId] = useState(agent.reportsToAgentId ?? '');
    const [isOrgSaving, setIsOrgSaving] = useState(false);

    const saveOrganization = async () => {
        if (!organization || isOrgSaving) return;
        setIsOrgSaving(true);
        try {
            const previousReportsTo = agent.reportsToAgentId ?? '';
            if (reportsToId !== previousReportsTo) {
                const updated = await updateAgentAction(agent.id, {
                    reportsToAgentId: reportsToId ? reportsToId : null,
                });
                setAgent(updated);
            }
            const membershipChanged =
                teamId !== (savedTeamIds[0] ?? '') || savedTeamIds.length > (teamId ? 1 : 0);
            if (membershipChanged) {
                // Add first, remove after — a mid-flight failure never leaves
                // the agent teamless; every stale membership is removed.
                if (teamId && !savedTeamIds.includes(teamId)) {
                    await addTeamMemberAction(organization.activeOrgId, teamId, {
                        memberType: 'agent',
                        memberId: agent.id,
                    });
                }
                for (const oldTeamId of savedTeamIds) {
                    if (oldTeamId !== teamId) {
                        await removeTeamMemberAction(
                            organization.activeOrgId,
                            oldTeamId,
                            'agent',
                            agent.id,
                        );
                    }
                }
                setSavedTeamIds(teamId ? [teamId] : []);
            }
            toast.success('Organization settings saved');
            router.refresh();
        } catch (error) {
            toast.error(
                error instanceof Error ? error.message : 'Could not save organization settings',
            );
        } finally {
            setIsOrgSaving(false);
        }
    };

    const save = () => {
        startSaving(async () => {
            try {
                const normalizedCadence = heartbeatCadence.trim();
                const updated = await updateAgentAction(agent.id, {
                    name: name.trim(),
                    title: title.trim() ? title.trim() : null,
                    capabilities: capabilities.trim() ? capabilities.trim() : null,
                    aiProviderId: aiProviderId.trim() ? aiProviderId.trim() : null,
                    modelId: modelId.trim() ? modelId.trim() : null,
                    environmentId: environmentId ? environmentId : null,
                    heartbeatCadence:
                        normalizedCadence.length === 0 || normalizedCadence === 'manual'
                            ? null
                            : normalizedCadence,
                    idleBehavior,
                    maxSkillContextTokens: Number(maxSkillContextTokens),
                    pauseAfterFailures: Number(pauseAfterFailures),
                    permissions,
                });
                setAgent(updated);
                toast.success('Agent settings saved');
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Could not save settings');
            }
        });
    };

    /**
     * Merge-policy matrix (Wave 3, D4) — the Agent slice rides the same
     * `PATCH /api/agents/:id` path as every other setting on this page, so
     * it inherits that endpoint's ownership checks unchanged. The local
     * `agent` copy is updated from the response so the card's
     * `storedOverride` (which drives reset-to-inherit) never lags the row.
     */
    const saveMergePolicy = async (next: MergePolicyOverride | null) => {
        try {
            const updated = await updateAgentAction(agent.id, { mergePolicy: next });
            setAgent(updated);
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'Could not save the merge policy',
            };
        }
    };

    const changeStatus = (action: 'pause' | 'resume') => {
        startChangingStatus(async () => {
            try {
                const updated =
                    action === 'pause'
                        ? await pauseAgentAction(agent.id)
                        : await resumeAgentAction(agent.id);
                setAgent(updated);
                toast.success(action === 'pause' ? 'Agent paused' : 'Agent activated');
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Could not update status');
            }
        });
    };

    /**
     * Restore is the archive button's counterpart, so it lives in the
     * same slot. No confirmation: it puts the Agent back paused, which
     * is exactly what Archive promised and is itself undoable.
     */
    const restore = () => {
        startChangingStatus(async () => {
            try {
                const updated = await unarchiveAgentAction(agent.id);
                setAgent(updated);
                toast.success(tArchived('unarchiveSuccess', { name: updated.name }));
                router.refresh();
            } catch (error) {
                toast.error(error instanceof Error ? error.message : tArchived('unarchiveError'));
            }
        });
    };

    const isArchived = agent.status === 'archived';
    const canPause = agent.status === 'active';
    const canResume =
        agent.status === 'draft' || agent.status === 'paused' || agent.status === 'error';

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            {/* Identity */}
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex items-start gap-3">
                        <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                            <IdCard className="w-4 h-4 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-sm font-medium text-text dark:text-text-dark">
                                Identity
                            </h2>
                            <p className="text-xs text-text-muted dark:text-text-muted-dark font-mono">
                                {agent.slug}
                            </p>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-border/60 px-2.5 py-1 text-xs capitalize text-text-secondary dark:border-border-dark/60 dark:text-text-secondary-dark">
                            {agent.status}
                        </span>
                        {canPause ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => changeStatus('pause')}
                                loading={isChangingStatus}
                                className="gap-1.5 px-2.5 py-1 text-xs"
                            >
                                <Pause className="h-3.5 w-3.5" />
                                {tIdentity('pause')}
                            </Button>
                        ) : null}
                        {canResume ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => changeStatus('resume')}
                                loading={isChangingStatus}
                                className="gap-1.5 px-2.5 py-1 text-xs"
                            >
                                <Play className="h-3.5 w-3.5" />
                                {agent.status === 'draft'
                                    ? tIdentity('activate')
                                    : tIdentity('resume')}
                            </Button>
                        ) : null}
                        {/* Archive is reversible (the archived tab restores
                            it), so it stays a secondary control and only
                            Delete carries the danger treatment — otherwise
                            two identically-red buttons sit side by side.
                            On an already-archived Agent the slot flips to
                            Restore: archiving it again is a no-op, and
                            undoing is the only move left besides Delete. */}
                        {isArchived ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={restore}
                                loading={isChangingStatus}
                                className="gap-1.5 px-2.5 py-1 text-xs"
                                data-testid="agent-settings-restore"
                            >
                                <ArchiveRestore className="h-3.5 w-3.5" />
                                {tArchived('unarchive')}
                            </Button>
                        ) : (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => setIsArchiveOpen(true)}
                                disabled={isChangingStatus}
                                className="gap-1.5 px-2.5 py-1 text-xs"
                                data-testid="agent-settings-archive"
                            >
                                <Archive className="h-3.5 w-3.5" />
                                {tIdentity('archive')}
                            </Button>
                        )}
                        <Button
                            variant="danger"
                            size="sm"
                            onClick={() => setIsDeleteOpen(true)}
                            disabled={isChangingStatus}
                            className="gap-1.5 px-2.5 py-1 text-xs"
                            data-testid="agent-settings-delete"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                            {tIdentity('delete')}
                        </Button>
                    </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    <Input
                        label="Name"
                        variant="form"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                    />
                    <Input
                        label="Title"
                        variant="form"
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                </div>
                <Textarea
                    label="Capabilities"
                    variant="form"
                    rows={4}
                    value={capabilities}
                    onChange={(event) => setCapabilities(event.target.value)}
                />
            </section>

            {/* Runtime */}
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <Cpu className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                        <h2 className="text-sm font-medium text-text dark:text-text-dark">
                            Runtime
                        </h2>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            Model, cadence, and idle behavior for this Agent.
                        </p>
                    </div>
                </div>
                <div className="grid gap-4 md:grid-cols-2">
                    {/* Provider and model were free-text id fields, which
                        required the user to already know the exact string.
                        Both are pickers now; both still accept a typed value
                        so an id this build doesn't know about stays reachable. */}
                    <SearchableSelect
                        label="AI provider"
                        value={aiProviderId}
                        onChange={(value) => {
                            setAiProviderId(value);
                            // The model list is provider-specific, so a model
                            // chosen under the previous provider is almost
                            // certainly invalid under the new one. Clearing
                            // falls back to the provider default rather than
                            // silently keeping an unroutable id.
                            //
                            // Only when the provider ACTUALLY changes: the
                            // picker fires onChange even when the user
                            // re-selects what was already chosen, and
                            // clearing then would silently discard a
                            // configured model on a no-op interaction.
                            if (value !== aiProviderId) {
                                setModelId('');
                            }
                        }}
                        options={aiProviderOptions}
                        emptyOptionLabel="Account default"
                        placeholder="Account default"
                        allowCustom
                        customLabel="Enter a provider id…"
                        customPlaceholder="e.g. openrouter"
                        testId="agent-ai-provider"
                    />
                    <div>
                        <label className="block text-xs font-medium text-text dark:text-text-dark mb-2">
                            Model
                        </label>
                        <PluginModelSelect
                            pluginId={aiProviderId}
                            value={modelId}
                            onChange={setModelId}
                            // NOT `!aiProviderId` alone: an Agent can hold a
                            // pinned modelId with no provider (the DTO fields
                            // are independent), and disabling then would make
                            // that model uneditable without first adopting a
                            // provider — which clears the model.
                            disabled={!aiProviderId && !modelId}
                        />
                        <p className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
                            {aiProviderId || modelId
                                ? 'Leave empty to use the provider default.'
                                : 'Pick an AI provider first.'}
                        </p>
                    </div>
                    {/* Environments — published Environments only (the
                        server refuses drafts with a 422; this filter is
                        the matching UI affordance). "None (default)"
                        clears back to the platform default runtime. */}
                    <SearchableSelect
                        label="Environment"
                        value={environmentId}
                        onChange={setEnvironmentId}
                        options={environmentOptions}
                        emptyOptionLabel="None (default)"
                        placeholder="None (default)"
                        testId="agent-environment"
                    />
                    <SearchableSelect
                        label="Heartbeat cadence"
                        value={heartbeatCadence}
                        onChange={setHeartbeatCadence}
                        options={heartbeatCadenceOptions}
                        placeholder="manual or cron expression"
                        allowCustom
                        customLabel="Enter a cron expression…"
                        customPlaceholder="0 9 * * *"
                        testId="agent-heartbeat-cadence"
                    />
                    <div>
                        <label className="block text-xs font-medium text-text dark:text-text-dark mb-2">
                            Idle behavior
                        </label>
                        <Select
                            value={idleBehavior}
                            onValueChange={(value) => setIdleBehavior(value as AgentIdleBehavior)}
                        >
                            {idleBehaviorOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </Select>
                    </div>
                    <Input
                        label="Skill context tokens"
                        variant="form"
                        type="number"
                        min={500}
                        max={20000}
                        value={maxSkillContextTokens}
                        onChange={(event) => setMaxSkillContextTokens(event.target.value)}
                    />
                    <Input
                        label="Pause after failures"
                        variant="form"
                        type="number"
                        min={1}
                        max={20}
                        value={pauseAfterFailures}
                        onChange={(event) => setPauseAfterFailures(event.target.value)}
                    />
                </div>
            </section>

            {/* Permissions */}
            <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                <div className="flex items-start gap-3">
                    <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                        <ShieldCheck className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                        <h2 className="text-sm font-medium text-text dark:text-text-dark">
                            Permissions
                        </h2>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark">
                            Control what this Agent is allowed to do on its own.
                        </p>
                    </div>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                    {permissionLabels.map((permission) => (
                        <div
                            key={permission.key}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border/50 px-3 py-2.5 text-sm text-text-secondary dark:border-border-dark/50 dark:text-text-secondary-dark"
                        >
                            <span>{permission.label}</span>
                            <Switch
                                className="mt-0"
                                checked={permissions[permission.key]}
                                onChange={(checked) =>
                                    setPermissions((current) => ({
                                        ...current,
                                        [permission.key]: checked,
                                    }))
                                }
                            />
                        </div>
                    ))}
                </div>
                <div className="flex justify-end">
                    <Button
                        onClick={save}
                        loading={isSaving}
                        size="sm"
                        className="gap-1.5 px-2.5 py-1 text-xs"
                    >
                        <Save className="h-3.5 w-3.5" />
                        Save settings
                    </Button>
                </div>
            </section>

            {/* Organization (Teams & Companies spec §4.3) — rendered only
                when the server page resolved an active Organization. Own
                Save button so team/manager edits stay independent of the
                main settings form. */}
            {organization ? (
                <section className="rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                    <div className="flex items-start gap-3">
                        <div className="shrink-0 w-9 h-9 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
                            <Building2 className="w-4 h-4 text-primary" strokeWidth={1.5} />
                        </div>
                        <div>
                            <h2 className="text-sm font-medium text-text dark:text-text-dark">
                                {tOrg('title')}
                            </h2>
                        </div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
                        <div>
                            <label
                                htmlFor="agent-settings-team"
                                className="block text-xs font-medium text-text dark:text-text-dark mb-2"
                            >
                                {tOrg('teamLabel')}
                            </label>
                            <select
                                id="agent-settings-team"
                                data-testid="agent-settings-team"
                                value={teamId}
                                onChange={(event) => setTeamId(event.target.value)}
                                className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                            >
                                <option value="">{tOrg('teamNone')}</option>
                                {organization.teams.map((option) => (
                                    <option key={option.id} value={option.id}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div>
                            <label
                                htmlFor="agent-settings-reports-to"
                                className="block text-xs font-medium text-text dark:text-text-dark mb-2"
                            >
                                {tOrg('reportsToLabel')}
                            </label>
                            <select
                                id="agent-settings-reports-to"
                                data-testid="agent-settings-reports-to"
                                value={reportsToId}
                                onChange={(event) => setReportsToId(event.target.value)}
                                className="w-full rounded-md border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark px-3 h-9 text-sm text-text dark:text-text-dark"
                            >
                                <option value="">{tOrg('reportsToNone')}</option>
                                {organization.agentOptions.map((option) => (
                                    <option key={option.id} value={option.id}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <div className="flex justify-end">
                        <Button
                            onClick={saveOrganization}
                            loading={isOrgSaving}
                            size="sm"
                            className="gap-1.5 px-2.5 py-1 text-xs"
                            data-testid="agent-settings-org-save"
                        >
                            <Save className="h-3.5 w-3.5" />
                            {isOrgSaving ? tOrg('saving') : tOrg('save')}
                        </Button>
                    </div>
                </section>
            ) : null}

            {/* Merge policy (Wave 3, D4) — the MOST specific scope of the
                matrix. Anything this Agent does not set inherits from its
                Work, then the organization, then the tenant, then the
                platform default; the card names the owner of every field. */}
            <MergePolicyCard
                scope="agent"
                agentId={agent.id}
                storedOverride={agent.mergePolicy ?? null}
                onSave={saveMergePolicy}
                title="Merge policy"
                subtitle="Whether this Agent may land the pull requests it opens, and under what conditions."
                testIdPrefix="agent-merge-policy"
            />

            {/* Scorecard (Agent Scorecards increment 1 — additive section) */}
            <AgentScorecardCard agent={agent} />

            {/* Both lifecycle confirmations. The former Danger-zone
                section is gone: Delete now lives in the Identity header
                beside Pause and Archive, and a second delete button
                further down was the same action twice. */}
            <ArchiveAgentDialog
                agent={agent}
                open={isArchiveOpen}
                onOpenChange={setIsArchiveOpen}
                onArchived={() => {
                    router.push('/agents');
                    router.refresh();
                }}
            />

            <DeleteAgentDialog
                agent={agent}
                open={isDeleteOpen}
                onOpenChange={setIsDeleteOpen}
                onDeleted={() => {
                    router.push('/agents');
                    router.refresh();
                }}
            />
        </div>
    );
}
