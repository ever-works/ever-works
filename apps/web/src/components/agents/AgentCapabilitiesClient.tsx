'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import { Plus, RotateCcw, ShieldCheck, Sparkles, TerminalSquare, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentCapabilitiesPayload, AgentCapabilityToolRow } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select';
import { ROUTES } from '@/lib/constants';
import type { Agent, AgentPermissions } from '@/lib/api/agents';
import { listAgentSkillsAction } from '@/app/actions/agents';
import { composeGrantForToggle, toolToggleState } from './agent-capabilities.shared';
import {
    bindSkillToAgentAction,
    installAndBindSkillAction,
    resetAgentToolGrantAction,
    setAgentToolGrantAction,
    unbindSkillFromAgentAction,
    updateAgentInitScriptAction,
} from '@/app/actions/agent-capabilities';

/**
 * Agent Capabilities tab — sectioned on purpose so the sibling features
 * built on parallel branches (MCP servers, repositories, environments)
 * can add their own sections without restructuring:
 *
 *   1. Agent tools   — the tool-grant matrix's first web UI.
 *   2. Permissions   — read-only summary; edited in Settings.
 *   3. Skills        — agent-scope bindings + inherited, read-only.
 *   4. Init Script   — advisory v1 bootstrap script.
 *
 * ## Tool-toggle semantics (narrowing only)
 *
 * A switch rewrites the AGENT-scope grant row, which the agent scope may
 * only ever use to NARROW what its ancestors allow. Which switches are
 * usable and what each one writes is decided by the pure functions in
 * `agent-capabilities.shared.ts` (`toolToggleState` /
 * `composeGrantForToggle`) — that is the policy half, unit-tested on its
 * own; everything below is layout.
 */

interface BoundSkill {
    bindingId: string;
    priority: number;
    targetType: string;
    skill: { id: string; slug: string; title: string; version: string };
}

interface SkillOption {
    id: string;
    slug: string;
    title: string;
    description: string;
}

interface CatalogOption {
    slug: string;
    title: string;
    description: string;
}

interface Props {
    agent: Agent;
    initialCapabilities: AgentCapabilitiesPayload;
    initialBoundSkills: BoundSkill[];
    installedSkills: SkillOption[];
    catalogSkills: CatalogOption[];
}

/** Same labels the Settings tab uses for the 8 flags. */
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

const INIT_SCRIPT_MAX_BYTES = 16 * 1024;

function byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
}

const sectionClass =
    'rounded-xl border border-border/60 dark:border-border-dark/60 bg-card dark:bg-card-primary-dark';

export function AgentCapabilitiesClient({
    agent,
    initialCapabilities,
    initialBoundSkills,
    installedSkills,
    catalogSkills,
}: Props) {
    const t = useTranslations('dashboard.agentsPage.capabilities');
    const [caps, setCaps] = useState(initialCapabilities);
    const [boundSkills, setBoundSkills] = useState(initialBoundSkills);
    const [pending, startTransition] = useTransition();
    const [busyTool, setBusyTool] = useState<string | null>(null);
    const [busySkill, setBusySkill] = useState<string | null>(null);
    const [skillPick, setSkillPick] = useState('');

    // ── Tools ─────────────────────────────────────────────────────────

    const toolGroups = useMemo(() => {
        const groups: Array<{ key: 'builtin' | 'facade' | 'domain'; label: string }> = [
            { key: 'builtin', label: t('tools.groupBuiltin') },
            { key: 'facade', label: t('tools.groupFacade') },
            { key: 'domain', label: t('tools.groupDomain') },
        ];
        return groups
            .map((group) => ({
                ...group,
                tools: caps.tools.filter((tool) => tool.source === group.key),
            }))
            .filter((group) => group.tools.length > 0);
    }, [caps.tools, t]);

    const toggleTool = (tool: AgentCapabilityToolRow, next: boolean) => {
        const grant = composeGrantForToggle(tool, caps.agentGrantRow, next);

        setBusyTool(tool.name);
        startTransition(() => {
            void (async () => {
                try {
                    setCaps(await setAgentToolGrantAction(agent.id, grant));
                } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                    setBusyTool(null);
                }
            })();
        });
    };

    const resetGrants = () => {
        const row = caps.agentGrantRow;
        if (!row) return;
        setBusyTool('__reset__');
        startTransition(() => {
            void (async () => {
                try {
                    setCaps(await resetAgentToolGrantAction(agent.id, row.id));
                } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                    setBusyTool(null);
                }
            })();
        });
    };

    // ── Skills ────────────────────────────────────────────────────────

    const agentBindings = boundSkills.filter((row) => row.targetType === 'agent');
    const inheritedBindings = boundSkills.filter((row) => row.targetType !== 'agent');

    const skillOptions: SearchableSelectOption[] = useMemo(() => {
        const boundIds = new Set(agentBindings.map((row) => row.skill.id));
        const installedSlugs = new Set(installedSkills.map((skill) => skill.slug));
        const installable: SearchableSelectOption[] = installedSkills
            .filter((skill) => !boundIds.has(skill.id))
            .map((skill) => ({
                value: `skill:${skill.id}`,
                label: skill.title,
                description: skill.slug,
            }));
        const fromCatalog: SearchableSelectOption[] = catalogSkills
            .filter((entry) => !installedSlugs.has(entry.slug))
            .map((entry) => ({
                value: `catalog:${entry.slug}`,
                label: `${entry.title} — ${t('skills.installAndAttach')}`,
                description: entry.slug,
            }));
        return [...installable, ...fromCatalog];
    }, [agentBindings, installedSkills, catalogSkills, t]);

    const refreshSkills = async () => {
        const next = await listAgentSkillsAction(agent.id);
        setBoundSkills(next.data);
    };

    const attachSkill = (value: string) => {
        setSkillPick(value);
        if (!value) return;
        setBusySkill(value);
        startTransition(() => {
            void (async () => {
                try {
                    if (value.startsWith('catalog:')) {
                        await installAndBindSkillAction(agent.id, value.slice('catalog:'.length));
                    } else if (value.startsWith('skill:')) {
                        await bindSkillToAgentAction(agent.id, value.slice('skill:'.length));
                    }
                    await refreshSkills();
                    setSkillPick('');
                } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                    setBusySkill(null);
                }
            })();
        });
    };

    const detachSkill = (bindingId: string) => {
        setBusySkill(bindingId);
        startTransition(() => {
            void (async () => {
                try {
                    await unbindSkillFromAgentAction(agent.id, bindingId);
                    await refreshSkills();
                } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                    setBusySkill(null);
                }
            })();
        });
    };

    // ── Init script ───────────────────────────────────────────────────

    const [savedScript, setSavedScript] = useState(initialCapabilities.initScript ?? '');
    const [script, setScript] = useState(initialCapabilities.initScript ?? '');
    const [savingScript, setSavingScript] = useState(false);
    const scriptBytes = byteLength(script);
    const scriptDirty = script !== savedScript;
    const scriptTooLong = scriptBytes > INIT_SCRIPT_MAX_BYTES;

    const saveScript = () => {
        setSavingScript(true);
        startTransition(() => {
            void (async () => {
                try {
                    const trimmedEmpty = script.trim().length === 0;
                    const result = await updateAgentInitScriptAction(
                        agent.id,
                        trimmedEmpty ? null : script,
                    );
                    if (result.ok) {
                        const persisted = result.agent.initScript ?? '';
                        setSavedScript(persisted);
                        setScript(persisted);
                        toast.success(t('initScript.saved'));
                    } else {
                        toast.error(result.message);
                    }
                } finally {
                    setSavingScript(false);
                }
            })();
        });
    };

    return (
        <div className="p-6 max-w-screen-2xl mx-auto space-y-6">
            <header>
                <h2 className="text-sm font-medium text-text dark:text-text-dark">{t('title')}</h2>
                <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
                    {t('subtitle')}
                </p>
            </header>

            {/* ── Section: Agent tools (tool-grant matrix) ── */}
            <section className={sectionClass} data-testid="capabilities-tools-section">
                <div className="p-4 border-b border-border/40 dark:border-border-dark/40 flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                            <Wrench className="w-4 h-4 text-primary" />
                            {t('tools.title')}
                        </h3>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                            {t('tools.description')}
                        </p>
                    </div>
                    {caps.agentGrantRow && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={resetGrants}
                            disabled={pending && busyTool === '__reset__'}
                            className="gap-1.5 shrink-0"
                            data-testid="capabilities-reset-grants"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            {t('tools.resetToInherited')}
                        </Button>
                    )}
                </div>
                {toolGroups.map((group) => (
                    <div key={group.key}>
                        <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-text-muted dark:text-text-muted-dark bg-background/40 dark:bg-background-dark/40 border-b border-border/40 dark:border-border-dark/40">
                            {group.label}
                        </div>
                        <div className="divide-y divide-border/40 dark:divide-border-dark/40">
                            {group.tools.map((tool) => {
                                const state = toolToggleState(
                                    tool,
                                    caps.agentGrantRow,
                                    caps.grants.chain,
                                );
                                const busy = pending && busyTool === tool.name;
                                return (
                                    <article
                                        key={tool.name}
                                        className="p-4 flex items-center gap-4"
                                        data-testid={`capabilities-tool-${tool.name}`}
                                    >
                                        <div className="min-w-0 flex-1">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <span className="text-sm font-mono text-text dark:text-text-dark">
                                                    {tool.name}
                                                </span>
                                                {state.kind === 'upstream-denied' && (
                                                    <span className="inline-flex items-center rounded-full bg-danger/10 text-danger px-2 py-0.5 text-[11px]">
                                                        {t('tools.inheritedDeny', {
                                                            scope: state.scope,
                                                        })}
                                                    </span>
                                                )}
                                                {state.kind === 'pattern-denied' && (
                                                    <span className="inline-flex items-center rounded-full bg-danger/10 text-danger px-2 py-0.5 text-[11px]">
                                                        {t('tools.patternDeny')}
                                                    </span>
                                                )}
                                                {state.kind === 'permission-off' && (
                                                    <span
                                                        className="inline-flex items-center rounded-full bg-warning/10 text-warning px-2 py-0.5 text-[11px]"
                                                        title={t('tools.permissionHint', {
                                                            permission: state.permission,
                                                        })}
                                                    >
                                                        {t('tools.permissionOff')}
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5 line-clamp-2">
                                                {tool.description}
                                            </p>
                                        </div>
                                        <Switch
                                            checked={
                                                state.kind === 'editable' ? state.checked : false
                                            }
                                            onChange={(next) => toggleTool(tool, next)}
                                            disabled={busy || state.kind !== 'editable'}
                                            className="mt-0 shrink-0"
                                            data-testid={`capabilities-tool-switch-${tool.name}`}
                                        />
                                    </article>
                                );
                            })}
                        </div>
                    </div>
                ))}
                {caps.tools.length === 0 && (
                    <div className="p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                        {t('tools.empty')}
                    </div>
                )}
            </section>

            {/* ── Section: Permissions summary (read-only) ── */}
            <section className={sectionClass} data-testid="capabilities-permissions-section">
                <div className="p-4 border-b border-border/40 dark:border-border-dark/40 flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                            <ShieldCheck className="w-4 h-4 text-primary" />
                            {t('permissions.title')}
                        </h3>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                            {t('permissions.description')}
                        </p>
                    </div>
                    <Link
                        href={ROUTES.DASHBOARD_AGENT_SETTINGS(agent.id)}
                        className="text-xs text-primary hover:underline shrink-0"
                        data-testid="capabilities-edit-permissions"
                    >
                        {t('permissions.edit')}
                    </Link>
                </div>
                <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-1">
                    {permissionLabels.map(({ key, label }) => (
                        <Switch
                            key={key}
                            checked={Boolean(caps.permissions[key])}
                            disabled
                            label={label}
                            data-testid={`capabilities-permission-${key}`}
                        />
                    ))}
                </div>
            </section>

            {/* ── Section: Skills ── */}
            <section className={sectionClass} data-testid="capabilities-skills-section">
                <div className="p-4 border-b border-border/40 dark:border-border-dark/40">
                    <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-primary" />
                        {t('skills.title')}
                    </h3>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                        {t('skills.description')}
                    </p>
                    <div className="mt-3 max-w-md flex items-start gap-2">
                        <Plus className="w-4 h-4 mt-2.5 text-text-muted dark:text-text-muted-dark shrink-0" />
                        <div className="flex-1">
                            <SearchableSelect
                                value={skillPick}
                                onChange={attachSkill}
                                options={skillOptions}
                                placeholder={t('skills.attachPlaceholder')}
                                disabled={pending && busySkill !== null}
                                testId="capabilities-attach-skill"
                            />
                        </div>
                    </div>
                </div>
                <div className="divide-y divide-border/40 dark:divide-border-dark/40">
                    {agentBindings.length === 0 && inheritedBindings.length === 0 && (
                        <div className="p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                            {t('skills.empty')}
                        </div>
                    )}
                    {agentBindings.map((row) => (
                        <article
                            key={row.bindingId}
                            className="p-4 flex items-center gap-3"
                            data-testid={`capabilities-skill-${row.skill.slug}`}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="text-sm text-text dark:text-text-dark truncate">
                                    {row.skill.title}{' '}
                                    <span className="text-text-muted dark:text-text-muted-dark text-xs font-mono">
                                        {row.skill.slug} · v{row.skill.version}
                                    </span>
                                </div>
                                <div className="mt-0.5 text-[11px] text-text-muted dark:text-text-muted-dark">
                                    priority {row.priority}
                                </div>
                            </div>
                            <Switch
                                checked
                                onChange={() => detachSkill(row.bindingId)}
                                disabled={pending && busySkill === row.bindingId}
                                className="mt-0 shrink-0"
                                data-testid={`capabilities-skill-switch-${row.skill.slug}`}
                            />
                        </article>
                    ))}
                    {inheritedBindings.map((row) => (
                        <article
                            key={row.bindingId}
                            className="p-4 flex items-center gap-3 opacity-80"
                            data-testid={`capabilities-skill-inherited-${row.skill.slug}`}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="text-sm text-text dark:text-text-dark truncate">
                                    {row.skill.title}{' '}
                                    <span className="text-text-muted dark:text-text-muted-dark text-xs font-mono">
                                        {row.skill.slug} · v{row.skill.version}
                                    </span>
                                </div>
                                <div className="mt-0.5 text-[11px] text-text-muted dark:text-text-muted-dark">
                                    priority {row.priority}
                                </div>
                            </div>
                            <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] shrink-0">
                                {t('skills.inherited')} · {row.targetType}
                            </span>
                        </article>
                    ))}
                </div>
            </section>

            {/* ── Section: Init Script ── */}
            <section className={sectionClass} data-testid="capabilities-init-script-section">
                <div className="p-4 border-b border-border/40 dark:border-border-dark/40">
                    <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                        <TerminalSquare className="w-4 h-4 text-primary" />
                        {t('initScript.title')}
                    </h3>
                    <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                        {t('initScript.helper')}
                    </p>
                </div>
                <div className="p-4 space-y-2">
                    <textarea
                        value={script}
                        onChange={(event) => setScript(event.target.value)}
                        placeholder={t('initScript.placeholder')}
                        rows={10}
                        spellCheck={false}
                        className="w-full rounded-lg border border-border/60 dark:border-border-dark/60 bg-background dark:bg-background-dark p-3 font-mono text-xs text-text dark:text-text-dark focus:outline-none focus:ring-2 focus:ring-ring dark:focus:ring-ring-dark resize-y"
                        data-testid="capabilities-init-script"
                    />
                    <div className="flex items-center justify-between gap-3">
                        <span
                            className={
                                scriptTooLong
                                    ? 'text-xs text-danger'
                                    : 'text-xs text-text-muted dark:text-text-muted-dark'
                            }
                        >
                            {scriptTooLong
                                ? t('initScript.tooLong')
                                : t('initScript.bytes', {
                                      used: (scriptBytes / 1024).toFixed(1),
                                      max: INIT_SCRIPT_MAX_BYTES / 1024,
                                  })}
                        </span>
                        <Button
                            size="sm"
                            onClick={saveScript}
                            disabled={!scriptDirty || scriptTooLong || savingScript}
                            data-testid="capabilities-init-script-save"
                        >
                            {savingScript ? '…' : t('initScript.save')}
                        </Button>
                    </div>
                </div>
            </section>
        </div>
    );
}
