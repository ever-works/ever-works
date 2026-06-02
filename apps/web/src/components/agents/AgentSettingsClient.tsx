'use client';

import { useState, useTransition } from 'react';
import { Archive, Pause, Play, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useRouter } from '@/i18n/navigation';
import {
    archiveAgentAction,
    pauseAgentAction,
    resumeAgentAction,
    updateAgentAction,
} from '@/app/actions/agents';
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

interface AgentSettingsClientProps {
    agent: Agent;
}

export function AgentSettingsClient({ agent: initialAgent }: AgentSettingsClientProps) {
    const router = useRouter();
    const [agent, setAgent] = useState(initialAgent);
    const [isSaving, startSaving] = useTransition();
    const [isChangingStatus, startChangingStatus] = useTransition();
    const [name, setName] = useState(agent.name);
    const [title, setTitle] = useState(agent.title ?? '');
    const [capabilities, setCapabilities] = useState(agent.capabilities ?? '');
    const [aiProviderId, setAiProviderId] = useState(agent.aiProviderId ?? '');
    const [modelId, setModelId] = useState(agent.modelId ?? '');
    const [heartbeatCadence, setHeartbeatCadence] = useState(agent.heartbeatCadence ?? 'manual');
    const [idleBehavior, setIdleBehavior] = useState<AgentIdleBehavior>(agent.idleBehavior);
    const [maxSkillContextTokens, setMaxSkillContextTokens] = useState(
        String(agent.maxSkillContextTokens),
    );
    const [pauseAfterFailures, setPauseAfterFailures] = useState(String(agent.pauseAfterFailures));
    const [permissions, setPermissions] = useState<AgentPermissions>(agent.permissions);

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

    const changeStatus = (action: 'pause' | 'resume' | 'archive') => {
        startChangingStatus(async () => {
            try {
                if (action === 'archive') {
                    const confirmed = window.confirm('Archive this agent?');
                    if (!confirmed) return;
                    await archiveAgentAction(agent.id);
                    toast.success('Agent archived');
                    router.push('/agents');
                    router.refresh();
                    return;
                }
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

    const canPause = agent.status === 'active';
    const canResume =
        agent.status === 'draft' || agent.status === 'paused' || agent.status === 'error';

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-4">
            <section className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h2 className="text-sm font-medium text-text dark:text-text-dark">
                            Identity
                        </h2>
                        <p className="text-xs text-text-muted font-mono">{agent.slug}</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-sm border border-border/60 px-2 py-1 text-xs capitalize text-text-secondary dark:border-border-dark/60 dark:text-text-secondary-dark">
                            {agent.status}
                        </span>
                        {canPause ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => changeStatus('pause')}
                                loading={isChangingStatus}
                            >
                                <Pause className="h-4 w-4" />
                                Pause
                            </Button>
                        ) : null}
                        {canResume ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => changeStatus('resume')}
                                loading={isChangingStatus}
                            >
                                <Play className="h-4 w-4" />
                                {agent.status === 'draft' ? 'Activate' : 'Resume'}
                            </Button>
                        ) : null}
                        <Button
                            variant="danger"
                            size="sm"
                            onClick={() => changeStatus('archive')}
                            loading={isChangingStatus}
                        >
                            <Archive className="h-4 w-4" />
                            Archive
                        </Button>
                    </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-1 text-xs text-text-muted">
                        <span>Name</span>
                        <input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            className="w-full rounded-sm border border-border/70 bg-background px-3 py-2 text-sm text-text outline-none focus:border-button-primary dark:border-border-dark/70 dark:bg-background-dark dark:text-text-dark"
                        />
                    </label>
                    <label className="space-y-1 text-xs text-text-muted">
                        <span>Title</span>
                        <input
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            className="w-full rounded-sm border border-border/70 bg-background px-3 py-2 text-sm text-text outline-none focus:border-button-primary dark:border-border-dark/70 dark:bg-background-dark dark:text-text-dark"
                        />
                    </label>
                </div>
                <label className="space-y-1 text-xs text-text-muted">
                    <span>Capabilities</span>
                    <textarea
                        value={capabilities}
                        onChange={(event) => setCapabilities(event.target.value)}
                        rows={4}
                        className="w-full rounded-sm border border-border/70 bg-background px-3 py-2 text-sm text-text outline-none focus:border-button-primary dark:border-border-dark/70 dark:bg-background-dark dark:text-text-dark"
                    />
                </label>
            </section>

            <section className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">Runtime</h2>
                <div className="grid gap-4 md:grid-cols-2">
                    <label className="space-y-1 text-xs text-text-muted">
                        <span>AI provider id</span>
                        <input
                            value={aiProviderId}
                            onChange={(event) => setAiProviderId(event.target.value)}
                            placeholder="Account default"
                            className="w-full rounded-sm border border-border/70 bg-background px-3 py-2 text-sm text-text outline-none focus:border-button-primary dark:border-border-dark/70 dark:bg-background-dark dark:text-text-dark"
                        />
                    </label>
                    <label className="space-y-1 text-xs text-text-muted">
                        <span>Model id</span>
                        <input
                            value={modelId}
                            onChange={(event) => setModelId(event.target.value)}
                            placeholder="Provider default"
                            className="w-full rounded-sm border border-border/70 bg-background px-3 py-2 text-sm text-text outline-none focus:border-button-primary dark:border-border-dark/70 dark:bg-background-dark dark:text-text-dark"
                        />
                    </label>
                    <label className="space-y-1 text-xs text-text-muted">
                        <span>Heartbeat cadence</span>
                        <input
                            value={heartbeatCadence}
                            onChange={(event) => setHeartbeatCadence(event.target.value)}
                            placeholder="manual or cron expression"
                            className="w-full rounded-sm border border-border/70 bg-background px-3 py-2 text-sm text-text outline-none focus:border-button-primary dark:border-border-dark/70 dark:bg-background-dark dark:text-text-dark"
                        />
                    </label>
                    <label className="space-y-1 text-xs text-text-muted">
                        <span>Idle behavior</span>
                        <select
                            value={idleBehavior}
                            onChange={(event) =>
                                setIdleBehavior(event.target.value as AgentIdleBehavior)
                            }
                            className="w-full rounded-sm border border-border/70 bg-background px-3 py-2 text-sm text-text outline-none focus:border-button-primary dark:border-border-dark/70 dark:bg-background-dark dark:text-text-dark"
                        >
                            {idleBehaviorOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="space-y-1 text-xs text-text-muted">
                        <span>Skill context tokens</span>
                        <input
                            type="number"
                            min={500}
                            max={20000}
                            value={maxSkillContextTokens}
                            onChange={(event) => setMaxSkillContextTokens(event.target.value)}
                            className="w-full rounded-sm border border-border/70 bg-background px-3 py-2 text-sm text-text outline-none focus:border-button-primary dark:border-border-dark/70 dark:bg-background-dark dark:text-text-dark"
                        />
                    </label>
                    <label className="space-y-1 text-xs text-text-muted">
                        <span>Pause after failures</span>
                        <input
                            type="number"
                            min={1}
                            max={20}
                            value={pauseAfterFailures}
                            onChange={(event) => setPauseAfterFailures(event.target.value)}
                            className="w-full rounded-sm border border-border/70 bg-background px-3 py-2 text-sm text-text outline-none focus:border-button-primary dark:border-border-dark/70 dark:bg-background-dark dark:text-text-dark"
                        />
                    </label>
                </div>
            </section>

            <section className="rounded-lg border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark p-5 space-y-4">
                <h2 className="text-sm font-medium text-text dark:text-text-dark">Permissions</h2>
                <div className="grid gap-3 md:grid-cols-2">
                    {permissionLabels.map((permission) => (
                        <label
                            key={permission.key}
                            className="flex items-center justify-between gap-3 rounded-sm border border-border/50 px-3 py-2 text-sm text-text-secondary dark:border-border-dark/50 dark:text-text-secondary-dark"
                        >
                            <span>{permission.label}</span>
                            <input
                                type="checkbox"
                                checked={permissions[permission.key]}
                                onChange={(event) =>
                                    setPermissions((current) => ({
                                        ...current,
                                        [permission.key]: event.target.checked,
                                    }))
                                }
                                className="h-4 w-4"
                            />
                        </label>
                    ))}
                </div>
                <div className="flex justify-end">
                    <Button onClick={save} loading={isSaving}>
                        <Save className="h-4 w-4" />
                        Save settings
                    </Button>
                </div>
            </section>
        </div>
    );
}
