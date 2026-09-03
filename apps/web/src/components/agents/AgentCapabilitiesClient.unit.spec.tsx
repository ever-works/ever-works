import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentCapabilitiesPayload, AgentCapabilityToolRow } from '@ever-works/contracts';
import type { Agent } from '@/lib/api/agents';
import { AgentCapabilitiesClient } from './AgentCapabilitiesClient';
import type { AgentFleetData } from './agent-fleet.shared';

/**
 * Capabilities tab — the wiring assertions.
 *
 * The switch POLICY (which control is usable, what each writes) is
 * covered by `agent-capabilities.shared.unit.spec.ts`; what this spec
 * pins is that the component actually routes those decisions to the
 * right server action with the right arguments, and that it re-renders
 * from the composed payload the action returns rather than from local
 * optimism.
 */

const setAgentToolGrantAction = vi.fn();
const resetAgentToolGrantAction = vi.fn();
const updateAgentInitScriptAction = vi.fn();
const bindSkillToAgentAction = vi.fn();
const installAndBindSkillAction = vi.fn();
const unbindSkillFromAgentAction = vi.fn();
const listAgentSkillsAction = vi.fn();
const updateAgentAction = vi.fn();
const listAgentMcpServersAction = vi.fn();
const setAgentMcpBindingAction = vi.fn();
const clearAgentMcpBindingAction = vi.fn();
const setAgentRepoAttachment = vi.fn();
const removeAgentRepoAttachment = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock('next-intl', () => ({
    useTranslations: () => (key: string, values?: Record<string, unknown>) =>
        values ? `${key}:${Object.values(values).join(',')}` : key,
}));
vi.mock('@/i18n/navigation', () => ({
    Link: ({ children, href }: { children: React.ReactNode; href: string }) => (
        <a href={href}>{children}</a>
    ),
}));
vi.mock('sonner', () => ({
    toast: {
        error: (...args: unknown[]) => toastError(...args),
        success: (...args: unknown[]) => toastSuccess(...args),
    },
}));
vi.mock('@/app/actions/agent-capabilities', () => ({
    setAgentToolGrantAction: (...args: unknown[]) => setAgentToolGrantAction(...args),
    resetAgentToolGrantAction: (...args: unknown[]) => resetAgentToolGrantAction(...args),
    updateAgentInitScriptAction: (...args: unknown[]) => updateAgentInitScriptAction(...args),
    bindSkillToAgentAction: (...args: unknown[]) => bindSkillToAgentAction(...args),
    installAndBindSkillAction: (...args: unknown[]) => installAndBindSkillAction(...args),
    unbindSkillFromAgentAction: (...args: unknown[]) => unbindSkillFromAgentAction(...args),
}));
vi.mock('@/app/actions/agents', () => ({
    listAgentSkillsAction: (...args: unknown[]) => listAgentSkillsAction(...args),
    updateAgentAction: (...args: unknown[]) => updateAgentAction(...args),
}));
vi.mock('@/app/actions/mcp-connections', () => ({
    listAgentMcpServersAction: (...args: unknown[]) => listAgentMcpServersAction(...args),
    setAgentMcpBindingAction: (...args: unknown[]) => setAgentMcpBindingAction(...args),
    clearAgentMcpBindingAction: (...args: unknown[]) => clearAgentMcpBindingAction(...args),
}));
vi.mock('@/app/actions/repo-connections', () => ({
    setAgentRepoAttachment: (...args: unknown[]) => setAgentRepoAttachment(...args),
    removeAgentRepoAttachment: (...args: unknown[]) => removeAgentRepoAttachment(...args),
}));
// The Execution section's own wiring is covered by
// `AgentFleetSection.unit.spec.tsx`; here it only needs to be importable.
vi.mock('@/app/actions/settings/fleet', () => ({
    setFleetAgentAffinityAction: vi.fn(),
    clearFleetAgentAffinityAction: vi.fn(),
}));

const AGENT_ID = 'agent-1';

const permissions = {
    canCreateAgents: false,
    canAssignTasks: true,
    canEditSkills: false,
    canEditAgentFiles: false,
    canSpend: false,
    canCommitToRepo: true,
    canOpenPullRequests: false,
    canCallExternalTools: true,
};

function agent(): Agent {
    return {
        id: AGENT_ID,
        userId: 'u1',
        scope: 'tenant',
        missionId: null,
        ideaId: null,
        workId: null,
        name: 'CEO',
        slug: 'ceo',
        title: null,
        capabilities: null,
        aiProviderId: null,
        modelId: null,
        maxSkillContextTokens: 4000,
        status: 'active',
        permissions,
        targets: null,
        reportsToAgentId: null,
        guardrails: null,
        heartbeatCadence: null,
        idleBehavior: 'propose',
        nextHeartbeatAt: null,
        lastRunAt: null,
        lastRunStatus: null,
        errorCount: 0,
        pauseAfterFailures: 3,
        avatarMode: 'initials',
        avatarIcon: null,
        avatarImageUrl: null,
        committerName: null,
        committerEmail: null,
        scorecard: null,
        initScript: null,
        contentHash: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as Agent;
}

function toolRow(over: Partial<AgentCapabilityToolRow> = {}): AgentCapabilityToolRow {
    return {
        name: 'searchWeb',
        description: 'Web search.',
        gatedByPermission: 'canCallExternalTools',
        source: 'facade',
        permissionEnabled: true,
        decision: { allowed: true, toolName: 'searchWeb', source: 'default' },
        effective: true,
        ...over,
    };
}

function payload(over: Partial<AgentCapabilitiesPayload> = {}): AgentCapabilitiesPayload {
    return {
        agentId: AGENT_ID,
        initScript: null,
        permissions,
        tools: [
            toolRow(),
            toolRow({
                name: 'getSkillBody',
                description: 'Read a bound skill.',
                gatedByPermission: null,
                source: 'builtin',
            }),
        ],
        grants: {
            matrix: { allow: ['*'], deny: [] },
            source: 'default',
            chain: [{ scope: 'default', id: null, allow: ['*'], deny: [], rejected: [] }],
        },
        agentGrantRow: null,
        ...over,
    };
}

/** MCP row as `GET /api/agents/:id/mcp-servers` returns it. */
function mcpRow(over: Record<string, unknown> = {}) {
    const { connection, ...rest } = over as {
        connection?: Record<string, unknown>;
    } & Record<string, unknown>;
    return {
        connection: {
            id: 'conn-1',
            name: 'linear',
            url: 'https://mcp.linear.app/sse',
            transport: 'sse',
            enabled: true,
            ...connection,
        },
        effectiveEnabled: true,
        bindingSource: 'agent',
        inheritedFromTenant: false,
        ...rest,
    };
}

/** Registry repo as `GET /api/agents/:id/repos` returns it. */
function repoRow(over: Record<string, unknown> = {}) {
    return {
        id: 'repo-1',
        name: 'ever-works',
        url: 'https://github.com/ever-works/ever-works',
        sourceType: 'manual',
        readonly: false,
        attached: true,
        attachmentEnabled: true,
        ...over,
    };
}

interface ExtraProps {
    initialMcpServers?: unknown[];
    initialRepos?: unknown[];
    environments?: Array<{ id: string; name: string }>;
    environmentId?: string | null;
    fleet?: AgentFleetData | null;
}

function renderTab(
    over: Partial<AgentCapabilitiesPayload> = {},
    boundSkills: unknown[] = [],
    extra: ExtraProps = {},
) {
    const caps = payload(over);
    render(
        <AgentCapabilitiesClient
            agent={{ ...agent(), environmentId: extra.environmentId ?? null } as Agent}
            initialCapabilities={caps}
            initialBoundSkills={boundSkills as never}
            installedSkills={[]}
            catalogSkills={[]}
            initialMcpServers={(extra.initialMcpServers ?? []) as never}
            initialRepos={(extra.initialRepos ?? []) as never}
            environments={extra.environments ?? []}
            fleet={extra.fleet ?? null}
        />,
    );
    return caps;
}

beforeEach(() => {
    vi.clearAllMocks();
    listAgentSkillsAction.mockResolvedValue({ data: [] });
    listAgentMcpServersAction.mockResolvedValue({ data: [] });
});

describe('AgentCapabilitiesClient — tools section', () => {
    it('groups tools by source and renders a switch per tool', () => {
        renderTab();
        expect(screen.getByTestId('capabilities-tool-searchWeb')).toBeInTheDocument();
        expect(screen.getByTestId('capabilities-tool-switch-getSkillBody')).toBeInTheDocument();
        expect(screen.getByText('tools.groupBuiltin')).toBeInTheDocument();
        expect(screen.getByText('tools.groupFacade')).toBeInTheDocument();
    });

    it('turning a tool OFF PUTs an agent-scope deny and re-renders from the returned payload', async () => {
        const user = userEvent.setup();
        setAgentToolGrantAction.mockResolvedValue(
            payload({
                tools: [
                    toolRow({
                        decision: {
                            allowed: false,
                            toolName: 'searchWeb',
                            source: 'agent',
                            code: 'tool-denied',
                        },
                        effective: false,
                    }),
                ],
                grants: {
                    matrix: { allow: ['*'], deny: ['searchWeb'] },
                    source: 'agent',
                    chain: [
                        { scope: 'default', id: null, allow: ['*'], deny: [], rejected: [] },
                        {
                            scope: 'agent',
                            id: AGENT_ID,
                            allow: [],
                            deny: ['searchWeb'],
                            rejected: [],
                        },
                    ],
                },
                agentGrantRow: { id: 'row-1', allow: null, deny: ['searchWeb'], note: null },
            }),
        );

        renderTab();
        await user.click(screen.getByTestId('capabilities-tool-switch-searchWeb'));

        await waitFor(() =>
            expect(setAgentToolGrantAction).toHaveBeenCalledWith(AGENT_ID, {
                deny: ['searchWeb'],
            }),
        );
        await waitFor(() =>
            expect(screen.getByTestId('capabilities-tool-switch-searchWeb')).toHaveAttribute(
                'aria-checked',
                'false',
            ),
        );
        // The returned payload carries a stored row, so Reset appears.
        expect(screen.getByTestId('capabilities-reset-grants')).toBeInTheDocument();
    });

    it('turning a tool ON re-sends the stored allow list WITH the tool added', async () => {
        const user = userEvent.setup();
        setAgentToolGrantAction.mockResolvedValue(payload());
        renderTab({
            tools: [
                toolRow({
                    decision: {
                        allowed: false,
                        toolName: 'searchWeb',
                        source: 'default',
                        code: 'tool-not-granted',
                    },
                    effective: false,
                }),
            ],
            grants: {
                matrix: { allow: ['createTask'], deny: [] },
                source: 'agent',
                chain: [
                    { scope: 'default', id: null, allow: ['*'], deny: [], rejected: [] },
                    {
                        scope: 'agent',
                        id: AGENT_ID,
                        allow: ['createTask'],
                        deny: [],
                        rejected: [],
                    },
                ],
            },
            agentGrantRow: { id: 'row-1', allow: ['createTask'], deny: [], note: null },
        });

        const toggle = screen.getByTestId('capabilities-tool-switch-searchWeb');
        expect(toggle).not.toBeDisabled();
        await user.click(toggle);

        await waitFor(() =>
            expect(setAgentToolGrantAction).toHaveBeenCalledWith(AGENT_ID, {
                allow: ['createTask', 'searchWeb'],
                deny: [],
            }),
        );
    });

    /**
     * Regression: `useTransition`'s `pending` is already false while the
     * PUT is in flight (the handler fires a detached async IIFE), so the
     * old `pending && busyTool === tool.name` guard disabled nothing. Two
     * quick clicks then composed their grants from the same stale
     * `agentGrantRow`, and the second PUT — which REPLACES the row —
     * silently dropped the first toggle's deny.
     */
    it('locks every tool switch while a toggle is in flight (no lost-write race)', async () => {
        const user = userEvent.setup();
        let release!: (value: AgentCapabilitiesPayload) => void;
        setAgentToolGrantAction.mockReturnValue(
            new Promise<AgentCapabilitiesPayload>((resolve) => {
                release = resolve;
            }),
        );
        renderTab();

        await user.click(screen.getByTestId('capabilities-tool-switch-searchWeb'));
        await waitFor(() => expect(setAgentToolGrantAction).toHaveBeenCalledTimes(1));

        const other = screen.getByTestId('capabilities-tool-switch-getSkillBody');
        await waitFor(() => expect(other).toBeDisabled());
        await user.click(other);
        expect(setAgentToolGrantAction).toHaveBeenCalledTimes(1);

        release(payload());
        await waitFor(() => expect(other).not.toBeDisabled());
    });

    /**
     * Regression: `PUT /api/tool-grants` writes `note = body.note ?? null`,
     * so a toggle that omits the stored note deletes the operator's
     * rationale for the entire grant row.
     */
    it('carries the stored grant note through a toggle', async () => {
        const user = userEvent.setup();
        setAgentToolGrantAction.mockResolvedValue(payload());
        renderTab({
            agentGrantRow: { id: 'row-1', allow: null, deny: [], note: 'SOC2 restriction' },
        });

        await user.click(screen.getByTestId('capabilities-tool-switch-searchWeb'));

        await waitFor(() =>
            expect(setAgentToolGrantAction).toHaveBeenCalledWith(AGENT_ID, {
                deny: ['searchWeb'],
                note: 'SOC2 restriction',
            }),
        );
    });

    it('locks the switch and badges the scope when a PARENT layer denies the tool', () => {
        renderTab({
            tools: [
                toolRow({
                    decision: {
                        allowed: false,
                        toolName: 'searchWeb',
                        source: 'organization',
                        code: 'tool-denied',
                    },
                    effective: false,
                }),
            ],
            grants: {
                matrix: { allow: ['*'], deny: ['searchWeb'] },
                source: 'organization',
                chain: [
                    { scope: 'default', id: null, allow: ['*'], deny: [], rejected: [] },
                    {
                        scope: 'organization',
                        id: 'org-1',
                        allow: [],
                        deny: ['searchWeb'],
                        rejected: [],
                    },
                ],
            },
        });

        expect(screen.getByTestId('capabilities-tool-switch-searchWeb')).toBeDisabled();
        expect(screen.getByText('tools.inheritedDeny:organization')).toBeInTheDocument();
    });

    it('locks the switch and points at Settings when the permission flag is off', () => {
        renderTab({
            tools: [toolRow({ permissionEnabled: false, effective: false })],
        });
        expect(screen.getByTestId('capabilities-tool-switch-searchWeb')).toBeDisabled();
        expect(screen.getByText('tools.permissionOff')).toBeInTheDocument();
    });

    it('hides Reset when the Agent inherits, and DELETEs the stored row when it does not', async () => {
        const user = userEvent.setup();
        resetAgentToolGrantAction.mockResolvedValue(payload());

        const { unmount } = render(
            <AgentCapabilitiesClient
                agent={agent()}
                initialCapabilities={payload()}
                initialBoundSkills={[]}
                installedSkills={[]}
                catalogSkills={[]}
            />,
        );
        expect(screen.queryByTestId('capabilities-reset-grants')).toBeNull();
        unmount();

        renderTab({
            agentGrantRow: { id: 'row-9', allow: null, deny: ['searchWeb'], note: null },
        });
        await user.click(screen.getByTestId('capabilities-reset-grants'));
        await waitFor(() =>
            expect(resetAgentToolGrantAction).toHaveBeenCalledWith(AGENT_ID, 'row-9'),
        );
    });
});

describe('AgentCapabilitiesClient — permissions summary', () => {
    it('renders the 8 flags read-only, reflecting the payload', () => {
        renderTab();
        expect(screen.getByTestId('capabilities-permission-canAssignTasks')).toHaveAttribute(
            'aria-checked',
            'true',
        );
        expect(screen.getByTestId('capabilities-permission-canSpend')).toHaveAttribute(
            'aria-checked',
            'false',
        );
        for (const key of Object.keys(permissions)) {
            expect(screen.getByTestId(`capabilities-permission-${key}`)).toBeDisabled();
        }
    });
});

describe('AgentCapabilitiesClient — init script', () => {
    it('saves the edited script and adopts the persisted value', async () => {
        const user = userEvent.setup();
        updateAgentInitScriptAction.mockResolvedValue({
            ok: true,
            agent: { ...agent(), initScript: 'pnpm install' },
        });
        renderTab();

        const editor = screen.getByTestId('capabilities-init-script');
        await user.type(editor, 'pnpm install');
        await user.click(screen.getByTestId('capabilities-init-script-save'));

        await waitFor(() =>
            expect(updateAgentInitScriptAction).toHaveBeenCalledWith(AGENT_ID, 'pnpm install'),
        );
        await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
        // Adopted → no longer dirty.
        await waitFor(() =>
            expect(screen.getByTestId('capabilities-init-script-save')).toBeDisabled(),
        );
    });

    it('clears the column with null when the editor is emptied', async () => {
        const user = userEvent.setup();
        updateAgentInitScriptAction.mockResolvedValue({
            ok: true,
            agent: { ...agent(), initScript: null },
        });
        renderTab({ initScript: 'old script' });

        await user.clear(screen.getByTestId('capabilities-init-script'));
        await user.click(screen.getByTestId('capabilities-init-script-save'));

        await waitFor(() =>
            expect(updateAgentInitScriptAction).toHaveBeenCalledWith(AGENT_ID, null),
        );
    });

    it('surfaces an API rejection as an error toast (Server Actions redact thrown messages)', async () => {
        const user = userEvent.setup();
        updateAgentInitScriptAction.mockResolvedValue({
            ok: false,
            message: 'Secret-like value detected in Agent init script',
        });
        renderTab();

        await user.type(screen.getByTestId('capabilities-init-script'), 'export TOKEN=x');
        await user.click(screen.getByTestId('capabilities-init-script-save'));

        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith(
                'Secret-like value detected in Agent init script',
            ),
        );
    });
});

describe('AgentCapabilitiesClient — skills section', () => {
    const bound = [
        {
            bindingId: 'b1',
            priority: 10,
            targetType: 'agent',
            skill: { id: 's1', slug: 'code-review', title: 'Code Review', version: '1.0.0' },
        },
        {
            bindingId: 'b2',
            priority: 5,
            targetType: 'tenant',
            skill: { id: 's2', slug: 'house-style', title: 'House Style', version: '2.0.0' },
        },
    ];

    it('separates agent-scope bindings from inherited ones', () => {
        renderTab({}, bound);
        expect(screen.getByTestId('capabilities-skill-code-review')).toBeInTheDocument();
        expect(screen.getByTestId('capabilities-skill-inherited-house-style')).toBeInTheDocument();
        // Inherited bindings are read-only — no switch is rendered for them.
        expect(screen.queryByTestId('capabilities-skill-switch-house-style')).toBeNull();
    });

    it('switching an agent binding off unbinds it and refreshes the list', async () => {
        const user = userEvent.setup();
        unbindSkillFromAgentAction.mockResolvedValue({ deleted: true });
        listAgentSkillsAction.mockResolvedValue({ data: [bound[1]] });
        renderTab({}, bound);

        await user.click(screen.getByTestId('capabilities-skill-switch-code-review'));

        await waitFor(() =>
            expect(unbindSkillFromAgentAction).toHaveBeenCalledWith(AGENT_ID, 'b1'),
        );
        await waitFor(() =>
            expect(screen.queryByTestId('capabilities-skill-code-review')).toBeNull(),
        );
    });
});

/**
 * The three sections consolidated from the parallel branches. Each is a
 * SECOND view over the same endpoint the standalone surface still uses,
 * so what these pin is the state mapping (enabled / disabled / inherited
 * / read-only) and the exact action call — not new server behaviour.
 */
describe('AgentCapabilitiesClient — MCP connections section', () => {
    it('reflects the effective state per connection', () => {
        renderTab({}, [], {
            initialMcpServers: [
                mcpRow(),
                mcpRow({
                    connection: { id: 'conn-2', name: 'notion' },
                    effectiveEnabled: false,
                    bindingSource: 'none',
                }),
            ],
        });

        expect(screen.getByTestId('capabilities-mcp-switch-linear')).toHaveAttribute(
            'aria-checked',
            'true',
        );
        expect(screen.getByTestId('capabilities-mcp-switch-notion')).toHaveAttribute(
            'aria-checked',
            'false',
        );
    });

    it('badges a tenant-supplied binding as inherited and offers no revert for it', () => {
        renderTab({}, [], {
            initialMcpServers: [
                mcpRow({ bindingSource: 'tenant', inheritedFromTenant: true }),
                mcpRow({ connection: { id: 'conn-2', name: 'notion' } }),
            ],
        });

        expect(screen.getByTestId('capabilities-mcp-inherited-linear')).toBeInTheDocument();
        // Revert only removes an AGENT override; there is none to remove.
        expect(screen.queryByTestId('capabilities-mcp-revert-linear')).toBeNull();
        expect(screen.getByTestId('capabilities-mcp-revert-notion')).toBeInTheDocument();
    });

    it('locks the switch when the connection itself is disabled workspace-wide', () => {
        renderTab({}, [], {
            initialMcpServers: [
                mcpRow({ connection: { enabled: false }, effectiveEnabled: false }),
            ],
        });
        expect(screen.getByTestId('capabilities-mcp-switch-linear')).toBeDisabled();
    });

    /**
     * `effectiveEnabled` is derived server-side from the agent override on
     * top of the tenant binding, so the component must adopt the RE-READ
     * list rather than flipping the row it clicked.
     */
    it('writes an agent override and re-renders from the re-read list', async () => {
        const user = userEvent.setup();
        setAgentMcpBindingAction.mockResolvedValue({});
        listAgentMcpServersAction.mockResolvedValue({
            data: [mcpRow({ effectiveEnabled: false })],
        });
        renderTab({}, [], { initialMcpServers: [mcpRow()] });

        await user.click(screen.getByTestId('capabilities-mcp-switch-linear'));

        await waitFor(() =>
            expect(setAgentMcpBindingAction).toHaveBeenCalledWith(AGENT_ID, 'conn-1', false),
        );
        await waitFor(() =>
            expect(screen.getByTestId('capabilities-mcp-switch-linear')).toHaveAttribute(
                'aria-checked',
                'false',
            ),
        );
    });

    it('reverting clears the agent override so the tenant binding decides again', async () => {
        const user = userEvent.setup();
        clearAgentMcpBindingAction.mockResolvedValue({});
        listAgentMcpServersAction.mockResolvedValue({
            data: [mcpRow({ bindingSource: 'tenant', inheritedFromTenant: true })],
        });
        renderTab({}, [], { initialMcpServers: [mcpRow()] });

        await user.click(screen.getByTestId('capabilities-mcp-revert-linear'));

        await waitFor(() =>
            expect(clearAgentMcpBindingAction).toHaveBeenCalledWith(AGENT_ID, 'conn-1'),
        );
        await waitFor(() =>
            expect(screen.getByTestId('capabilities-mcp-inherited-linear')).toBeInTheDocument(),
        );
    });
});

describe('AgentCapabilitiesClient — repositories section', () => {
    it('renders manual repos as toggles reflecting the attachment', () => {
        renderTab({}, [], {
            initialRepos: [
                repoRow(),
                repoRow({ id: 'repo-2', name: 'docs', attached: false, attachmentEnabled: false }),
            ],
        });

        expect(screen.getByTestId('capabilities-repo-switch-ever-works')).toHaveAttribute(
            'aria-checked',
            'true',
        );
        expect(screen.getByTestId('capabilities-repo-switch-docs')).toHaveAttribute(
            'aria-checked',
            'false',
        );
    });

    it('renders a Work-derived repo READ-ONLY with its source badge', () => {
        renderTab({}, [], {
            initialRepos: [
                repoRow({ id: 'repo-3', name: 'from-work', sourceType: 'work' }),
                repoRow(),
            ],
        });

        expect(screen.queryByTestId('capabilities-repo-switch-from-work')).toBeNull();
        expect(screen.getByTestId('capabilities-repo-source-from-work')).toHaveTextContent(
            'repositories.source:work',
        );
        // A GitHub-App / manual row next to it stays toggleable.
        expect(screen.getByTestId('capabilities-repo-switch-ever-works')).toBeInTheDocument();
    });

    it('also renders an explicitly readonly registry row without a switch', () => {
        renderTab({}, [], {
            initialRepos: [repoRow({ id: 'repo-4', name: 'locked', readonly: true })],
        });
        expect(screen.queryByTestId('capabilities-repo-switch-locked')).toBeNull();
        expect(screen.getByTestId('capabilities-repo-source-locked')).toBeInTheDocument();
    });

    it('attaches and detaches through the repo endpoints', async () => {
        const user = userEvent.setup();
        setAgentRepoAttachment.mockResolvedValue({ success: true, data: {}, error: null });
        removeAgentRepoAttachment.mockResolvedValue({ success: true, data: {}, error: null });
        renderTab({}, [], {
            initialRepos: [
                repoRow({ id: 'repo-2', name: 'docs', attached: false, attachmentEnabled: false }),
            ],
        });

        await user.click(screen.getByTestId('capabilities-repo-switch-docs'));
        await waitFor(() =>
            expect(setAgentRepoAttachment).toHaveBeenCalledWith(AGENT_ID, 'repo-2', true),
        );
        await waitFor(() =>
            expect(screen.getByTestId('capabilities-repo-switch-docs')).toHaveAttribute(
                'aria-checked',
                'true',
            ),
        );

        await user.click(screen.getByTestId('capabilities-repo-switch-docs'));
        await waitFor(() =>
            expect(removeAgentRepoAttachment).toHaveBeenCalledWith(AGENT_ID, 'repo-2'),
        );
    });

    it('surfaces a failed attachment as a toast and leaves the switch alone', async () => {
        const user = userEvent.setup();
        setAgentRepoAttachment.mockResolvedValue({
            success: false,
            data: null,
            error: 'Repository is disabled',
        });
        renderTab({}, [], {
            initialRepos: [
                repoRow({ id: 'repo-2', name: 'docs', attached: false, attachmentEnabled: false }),
            ],
        });

        await user.click(screen.getByTestId('capabilities-repo-switch-docs'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('Repository is disabled'));
        expect(screen.getByTestId('capabilities-repo-switch-docs')).toHaveAttribute(
            'aria-checked',
            'false',
        );
    });
});

describe('AgentCapabilitiesClient — environment section', () => {
    const environments = [
        { id: 'env-1', name: 'Node 22 sandbox' },
        { id: 'env-2', name: 'Python ML' },
    ];

    it('shows the assigned environment and assigns the picked one', async () => {
        const user = userEvent.setup();
        updateAgentAction.mockResolvedValue({ ...agent(), environmentId: 'env-2' });
        renderTab({}, [], { environments, environmentId: 'env-1' });

        const trigger = screen.getByTestId('capabilities-environment-trigger');
        expect(trigger).toHaveTextContent('Node 22 sandbox');

        await user.click(trigger);
        await user.click(screen.getByRole('option', { name: /Python ML/ }));

        await waitFor(() =>
            expect(updateAgentAction).toHaveBeenCalledWith(AGENT_ID, { environmentId: 'env-2' }),
        );
    });

    /**
     * The column is nullable and the picker's "None" is the empty string:
     * sending `''` would be a value the API rejects rather than a clear.
     */
    it('CLEARS the assignment with null when "None" is picked', async () => {
        const user = userEvent.setup();
        updateAgentAction.mockResolvedValue({ ...agent(), environmentId: null });
        renderTab({}, [], { environments, environmentId: 'env-1' });

        await user.click(screen.getByTestId('capabilities-environment-trigger'));
        await user.click(screen.getByText('environment.none'));

        await waitFor(() =>
            expect(updateAgentAction).toHaveBeenCalledWith(AGENT_ID, { environmentId: null }),
        );
    });

    it('restores the previous selection when the assignment is rejected', async () => {
        const user = userEvent.setup();
        updateAgentAction.mockRejectedValue(new Error('Environment is not published'));
        renderTab({}, [], { environments, environmentId: 'env-1' });

        await user.click(screen.getByTestId('capabilities-environment-trigger'));
        await user.click(screen.getByRole('option', { name: /Python ML/ }));

        await waitFor(() =>
            expect(toastError).toHaveBeenCalledWith('Environment is not published'),
        );
        await waitFor(() =>
            expect(screen.getByTestId('capabilities-environment-trigger')).toHaveTextContent(
                'Node 22 sandbox',
            ),
        );
    });
});

/**
 * The Execution section is composed from Fleet reads the page may not be
 * able to make (Fleet disabled, API unreachable). Its internals are
 * pinned by `AgentFleetSection.unit.spec.tsx`; what matters here is the
 * page-level contract: no fleet data, no section — never an empty card.
 */
describe('AgentCapabilitiesClient — execution section', () => {
    it('is hidden when the page hands over no fleet data', () => {
        renderTab();
        expect(screen.queryByTestId('capabilities-fleet-section')).toBeNull();
    });

    it('renders the preferred-node picker and routing from the fleet data', () => {
        renderTab({}, [], {
            fleet: {
                nodes: [
                    {
                        id: 'node-1',
                        name: 'Office PC',
                        kind: 'desktop-node',
                        status: 'online',
                        platform: 'win32/x64',
                        version: null,
                        capabilities: [],
                        lastHeartbeatAt: null,
                        createdAt: null,
                        persisted: true,
                    },
                ],
                affinity: { available: true, nodeId: 'node-1' },
                preferences: [],
            },
        });

        expect(screen.getByTestId('capabilities-fleet-section')).toBeInTheDocument();
        expect(screen.getByTestId('capabilities-fleet-node')).toHaveTextContent('Office PC');
        expect(screen.getByTestId('capabilities-fleet-routing-mode')).toHaveTextContent(
            'routing.modes.local-fallback.label',
        );
    });
});
