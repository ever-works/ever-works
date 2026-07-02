'use client';

import { useState, useTransition } from 'react';
import { Archive, Cpu, IdCard, Pause, Play, Save, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
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
                                Pause
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
                                {agent.status === 'draft' ? 'Activate' : 'Resume'}
                            </Button>
                        ) : null}
                        <Button
                            variant="danger"
                            size="sm"
                            onClick={() => changeStatus('archive')}
                            loading={isChangingStatus}
                            className="gap-1.5 px-2.5 py-1 text-xs"
                        >
                            <Archive className="h-3.5 w-3.5" />
                            Archive
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
                    <Input
                        label="AI provider id"
                        variant="form"
                        value={aiProviderId}
                        onChange={(event) => setAiProviderId(event.target.value)}
                        placeholder="Account default"
                    />
                    <Input
                        label="Model id"
                        variant="form"
                        value={modelId}
                        onChange={(event) => setModelId(event.target.value)}
                        placeholder="Provider default"
                    />
                    <Input
                        label="Heartbeat cadence"
                        variant="form"
                        value={heartbeatCadence}
                        onChange={(event) => setHeartbeatCadence(event.target.value)}
                        placeholder="manual or cron expression"
                    />
                    <div>
                        <label className="block text-xs font-medium text-text dark:text-text-dark mb-2">
                            Idle behavior
                        </label>
                        <Select
                            value={idleBehavior}
                            onValueChange={(value) =>
                                setIdleBehavior(value as AgentIdleBehavior)
                            }
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
        </div>
    );
}
