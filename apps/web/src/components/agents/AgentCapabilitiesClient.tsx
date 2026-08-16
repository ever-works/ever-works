'use client';

import { useMemo, useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import {
    Boxes,
    FolderGit2,
    Plug,
    Plus,
    RotateCcw,
    ShieldCheck,
    Sparkles,
    TerminalSquare,
    Wrench,
} from 'lucide-react';
import { toast } from 'sonner';
import type { AgentCapabilitiesPayload, AgentCapabilityToolRow } from '@ever-works/contracts';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { SearchableSelect, type SearchableSelectOption } from '@/components/ui/searchable-select';
import { ROUTES } from '@/lib/constants';
// TYPE-ONLY on purpose: `@/lib/api/*` modules open with `import
// 'server-only'`, which hard-fails the production build the moment a
// 'use client' module takes a VALUE from one. Types are erased, so these
// three imports are safe; the runtime calls all go through the Server
// Actions imported below.
import type { Agent, AgentPermissions } from '@/lib/api/agents';
import type { AgentMcpServerState } from '@/lib/api/mcp-connections';
import type { AgentRepoDto } from '@/lib/api/repo-connections';
import { listAgentSkillsAction, updateAgentAction } from '@/app/actions/agents';
import {
    clearAgentMcpBindingAction,
    listAgentMcpServersAction,
    setAgentMcpBindingAction,
} from '@/app/actions/mcp-connections';
import { removeAgentRepoAttachment, setAgentRepoAttachment } from '@/app/actions/repo-connections';
import {
    composeGrantForToggle,
    repoIsReadOnly,
    toolToggleState,
} from './agent-capabilities.shared';
import {
    bindSkillToAgentAction,
    installAndBindSkillAction,
    resetAgentToolGrantAction,
    setAgentToolGrantAction,
    unbindSkillFromAgentAction,
    updateAgentInitScriptAction,
} from '@/app/actions/agent-capabilities';

/**
 * Agent Capabilities tab — ONE page listing everything this agent can
 * use. The sibling features that shipped on parallel branches now each
 * own a section here:
 *
 *   1. Agent tools   — the tool-grant matrix's first web UI.
 *   2. Permissions   — read-only summary; edited in Settings.
 *   3. Skills        — agent-scope bindings + inherited, read-only.
 *   4. MCP           — per-agent MCP connection state + inherited badge.
 *   5. Repositories  — registry attachments; Work-derived rows read-only.
 *   6. Environment   — the published Environment this agent runs in.
 *   7. Init Script   — advisory v1 bootstrap script.
 *
 * Sections 4-6 are CONSOLIDATION, not a move: the standalone MCP Servers
 * tab, the Repositories card on Settings and the Settings Environment
 * picker all keep working over the very same endpoints. Every one of
 * them is a second view over the same server state, so each mutation
 * here re-reads (MCP) or patches the row it owns (repos) rather than
 * assuming this page is the only writer.
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
    /**
     * Effective per-agent MCP state for every connection the user owns
     * (`GET /api/agents/:id/mcp-servers`). Defaults to empty so a flaky
     * connections API degrades the section rather than the page — and so
     * the standalone MCP Servers tab remains the unchanged source of
     * truth for the same rows.
     */
    initialMcpServers?: AgentMcpServerState[];
    /** Registry repos with this agent's attachment state (`GET /api/agents/:id/repos`). */
    initialRepos?: AgentRepoDto[];
    /**
     * PUBLISHED environments only — the server refuses assigning a draft
     * with a 422, so the picker offers exactly what it will accept.
     */
    environments?: Array<{ id: string; name: string }>;
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
    initialMcpServers = [],
    initialRepos = [],
    environments = [],
}: Props) {
    const t = useTranslations('dashboard.agentsPage.capabilities');
    const [caps, setCaps] = useState(initialCapabilities);
    const [boundSkills, setBoundSkills] = useState(initialBoundSkills);
    // `useTransition`'s `pending` is deliberately NOT the busy signal: the
    // work below is a fire-and-forget async IIFE, so the transition scope
    // returns synchronously and `pending` is already false while the PUT
    // is still in flight. Gating a switch on it disables nothing, and two
    // quick clicks then compose their grants from the SAME stale
    // `agentGrantRow` — the second PUT replaces the row and silently drops
    // the first toggle's deny. `busyTool` / `busySkill` are the real
    // in-flight markers, so they gate on their own.
    const [, startTransition] = useTransition();
    const [busyTool, setBusyTool] = useState<string | null>(null);
    const [busySkill, setBusySkill] = useState<string | null>(null);
    const [skillPick, setSkillPick] = useState('');
    const toolsBusy = busyTool !== null;
    const skillsBusy = busySkill !== null;

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
        // Second line of defence behind the disabled switches: every grant
        // is composed from the CURRENT `agentGrantRow`, so overlapping
        // writes lose whichever one lands first.
        if (toolsBusy) return;
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
        if (!row || toolsBusy) return;
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
        if (!value || skillsBusy) return;
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
        if (skillsBusy) return;
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

    // ── MCP connections ───────────────────────────────────────────────

    const [mcpRows, setMcpRows] = useState(initialMcpServers);
    const [busyMcp, setBusyMcp] = useState<string | null>(null);

    /**
     * Every MCP mutation re-reads the list instead of patching the row
     * locally: `effectiveEnabled` is DERIVED server-side from the agent
     * override on top of the tenant binding, so a local guess is only
     * right for the row that was clicked and only until the tenant
     * binding changes underneath it.
     */
    const runMcp = (connectionId: string, fn: () => Promise<unknown>) => {
        if (busyMcp) return;
        setBusyMcp(connectionId);
        startTransition(() => {
            void (async () => {
                try {
                    await fn();
                    const next = await listAgentMcpServersAction(agent.id);
                    setMcpRows(next.data);
                } catch (err) {
                    toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                    setBusyMcp(null);
                }
            })();
        });
    };

    // ── Repositories ──────────────────────────────────────────────────

    const [repoRows, setRepoRows] = useState(initialRepos);
    const [busyRepo, setBusyRepo] = useState<string | null>(null);

    const toggleRepo = (repo: AgentRepoDto, next: boolean) => {
        if (busyRepo || repoIsReadOnly(repo)) return;
        setBusyRepo(repo.id);
        startTransition(() => {
            void (async () => {
                try {
                    const result = next
                        ? await setAgentRepoAttachment(agent.id, repo.id, true)
                        : await removeAgentRepoAttachment(agent.id, repo.id);
                    if (!result.success) {
                        toast.error(result.error || t('repositories.toggleError'));
                        return;
                    }
                    setRepoRows((current) =>
                        current.map((row) =>
                            row.id === repo.id
                                ? { ...row, attached: next, attachmentEnabled: next }
                                : row,
                        ),
                    );
                } finally {
                    setBusyRepo(null);
                }
            })();
        });
    };

    // ── Environment ───────────────────────────────────────────────────

    const [environmentId, setEnvironmentId] = useState(agent.environmentId ?? '');
    const [savingEnvironment, setSavingEnvironment] = useState(false);

    const environmentOptions: SearchableSelectOption[] = useMemo(
        () => environments.map((row) => ({ value: row.id, label: row.name })),
        [environments],
    );

    const pickEnvironment = (value: string) => {
        if (savingEnvironment || value === environmentId) return;
        const previous = environmentId;
        setEnvironmentId(value);
        setSavingEnvironment(true);
        startTransition(() => {
            void (async () => {
                try {
                    // `''` is the picker's "None (default)"; the column is
                    // nullable, so it must be CLEARED with null rather than
                    // written as an empty string the API would reject.
                    await updateAgentAction(agent.id, { environmentId: value ? value : null });
                    toast.success(t('environment.saved'));
                } catch (err) {
                    setEnvironmentId(previous);
                    toast.error(err instanceof Error ? err.message : String(err));
                } finally {
                    setSavingEnvironment(false);
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
                            disabled={toolsBusy}
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
                                            disabled={toolsBusy || state.kind !== 'editable'}
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
                                disabled={skillsBusy}
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
                                disabled={skillsBusy}
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

            {/* ── Section: MCP connections ──
                Same rows as the standalone MCP Servers tab, which keeps
                working unchanged — this is a second view over the SAME
                `GET/PUT /api/agents/:id/mcp-servers`, not a move. */}
            <section className={sectionClass} data-testid="capabilities-mcp-section">
                <div className="p-4 border-b border-border/40 dark:border-border-dark/40 flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                            <Plug className="w-4 h-4 text-primary" />
                            {t('mcp.title')}
                        </h3>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                            {t('mcp.description')}
                        </p>
                    </div>
                    <Link
                        href={ROUTES.DASHBOARD_AGENT_MCP_SERVERS(agent.id)}
                        className="text-xs text-primary hover:underline shrink-0"
                        data-testid="capabilities-manage-mcp"
                    >
                        {t('mcp.manage')}
                    </Link>
                </div>
                <div className="divide-y divide-border/40 dark:divide-border-dark/40">
                    {mcpRows.length === 0 && (
                        <div className="p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                            {t('mcp.empty')}
                        </div>
                    )}
                    {mcpRows.map((row) => (
                        <article
                            key={row.connection.id}
                            className="p-4 flex items-center gap-3"
                            data-testid={`capabilities-mcp-${row.connection.name}`}
                        >
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-sm text-text dark:text-text-dark truncate">
                                        {row.connection.name}
                                    </span>
                                    <span className="text-text-muted dark:text-text-muted-dark text-xs font-mono">
                                        {row.connection.transport}
                                    </span>
                                    {row.inheritedFromTenant && (
                                        <span
                                            className="inline-flex items-center rounded-full bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-0.5 text-[11px] text-text-muted dark:text-text-muted-dark"
                                            data-testid={`capabilities-mcp-inherited-${row.connection.name}`}
                                        >
                                            {t('mcp.inherited')}
                                        </span>
                                    )}
                                    {row.bindingSource === 'agent' && (
                                        <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                                            {t('mcp.overridden')}
                                        </span>
                                    )}
                                    {!row.connection.enabled && (
                                        <span className="inline-flex items-center rounded-full bg-danger/10 px-2 py-0.5 text-[11px] text-danger">
                                            {t('mcp.connectionDisabled')}
                                        </span>
                                    )}
                                </div>
                                <div className="mt-0.5 text-[11px] font-mono text-text-muted dark:text-text-muted-dark truncate">
                                    {row.connection.url}
                                </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {row.bindingSource === 'agent' && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() =>
                                            runMcp(row.connection.id, () =>
                                                clearAgentMcpBindingAction(
                                                    agent.id,
                                                    row.connection.id,
                                                ),
                                            )
                                        }
                                        disabled={busyMcp !== null}
                                        className="gap-1"
                                        data-testid={`capabilities-mcp-revert-${row.connection.name}`}
                                    >
                                        <RotateCcw className="w-3.5 h-3.5" />
                                        {t('mcp.revert')}
                                    </Button>
                                )}
                                <Switch
                                    checked={row.effectiveEnabled}
                                    // A connection disabled workspace-wide cannot be
                                    // turned on for one agent — the same rule the
                                    // MCP Servers tab enforces.
                                    disabled={busyMcp !== null || !row.connection.enabled}
                                    onChange={(checked) =>
                                        runMcp(row.connection.id, () =>
                                            setAgentMcpBindingAction(
                                                agent.id,
                                                row.connection.id,
                                                checked,
                                            ),
                                        )
                                    }
                                    className="mt-0"
                                    data-testid={`capabilities-mcp-switch-${row.connection.name}`}
                                />
                            </div>
                        </article>
                    ))}
                </div>
            </section>

            {/* ── Section: Repositories ──
                Mirrors the Settings → Repositories card (which stays), over
                the same `GET/PUT /api/agents/:id/repos`. */}
            <section className={sectionClass} data-testid="capabilities-repos-section">
                <div className="p-4 border-b border-border/40 dark:border-border-dark/40 flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                            <FolderGit2 className="w-4 h-4 text-primary" />
                            {t('repositories.title')}
                        </h3>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                            {t('repositories.description')}
                        </p>
                    </div>
                    <Link
                        href={ROUTES.DASHBOARD_SETTINGS_REPOSITORIES}
                        className="text-xs text-primary hover:underline shrink-0"
                        data-testid="capabilities-manage-repos"
                    >
                        {t('repositories.manage')}
                    </Link>
                </div>
                <div className="divide-y divide-border/40 dark:divide-border-dark/40">
                    {repoRows.length === 0 && (
                        <div className="p-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                            {t('repositories.empty')}
                        </div>
                    )}
                    {repoRows.map((repo) => {
                        const readOnly = repoIsReadOnly(repo);
                        return (
                            <article
                                key={repo.id}
                                className={`p-4 flex items-center gap-3${readOnly ? ' opacity-80' : ''}`}
                                data-testid={`capabilities-repo-${repo.name}`}
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-sm text-text dark:text-text-dark truncate">
                                            {repo.name}
                                        </span>
                                        {readOnly && (
                                            <span
                                                className="inline-flex items-center rounded-full bg-surface-secondary dark:bg-surface-secondary-dark px-2 py-0.5 text-[11px] text-text-muted dark:text-text-muted-dark"
                                                data-testid={`capabilities-repo-source-${repo.name}`}
                                            >
                                                {t('repositories.source', {
                                                    source: repo.sourceType,
                                                })}
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-0.5 text-[11px] font-mono text-text-muted dark:text-text-muted-dark truncate">
                                        {repo.url}
                                    </div>
                                </div>
                                {readOnly ? (
                                    <span className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[11px] shrink-0">
                                        {repo.attached
                                            ? t('repositories.attached')
                                            : t('repositories.notAttached')}
                                    </span>
                                ) : (
                                    <Switch
                                        checked={repo.attached && repo.attachmentEnabled}
                                        disabled={busyRepo !== null}
                                        onChange={(checked) => toggleRepo(repo, checked)}
                                        className="mt-0 shrink-0"
                                        data-testid={`capabilities-repo-switch-${repo.name}`}
                                    />
                                )}
                            </article>
                        );
                    })}
                </div>
            </section>

            {/* ── Section: Environment ── */}
            <section className={sectionClass} data-testid="capabilities-environment-section">
                <div className="p-4 border-b border-border/40 dark:border-border-dark/40 flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-medium text-text dark:text-text-dark flex items-center gap-2">
                            <Boxes className="w-4 h-4 text-primary" />
                            {t('environment.title')}
                        </h3>
                        <p className="text-xs text-text-muted dark:text-text-muted-dark mt-1 max-w-2xl">
                            {t('environment.description')}
                        </p>
                    </div>
                    <Link
                        href={ROUTES.DASHBOARD_SETTINGS_ENVIRONMENTS}
                        className="text-xs text-primary hover:underline shrink-0"
                        data-testid="capabilities-manage-environments"
                    >
                        {t('environment.manage')}
                    </Link>
                </div>
                <div className="p-4 max-w-md">
                    <SearchableSelect
                        value={environmentId}
                        onChange={pickEnvironment}
                        options={environmentOptions}
                        emptyOptionLabel={t('environment.none')}
                        placeholder={t('environment.none')}
                        disabled={savingEnvironment}
                        testId="capabilities-environment"
                    />
                    {environments.length === 0 && (
                        <p className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">
                            {t('environment.empty')}
                        </p>
                    )}
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
