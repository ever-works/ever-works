import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    AgentRepository,
    AgentRunRepository,
    WorkRepository,
    type OwnershipScope,
} from '@ever-works/agent/database';
import {
    canStartFleetSession,
    FLEET_SESSION_NODE_PORT,
    FleetAccessService,
    FleetCheckoutRepository,
    FleetKillSwitchService,
    FleetNodeRepository,
    FleetSessionRepository,
    FleetSessionTaskService,
    type FleetSessionNodePort,
} from '@ever-works/agent/fleet';
import { resolveTaskRepository, taskBranchName, TasksService } from '@ever-works/agent/tasks-domain';
import {
    buildFleetTaskFirstMessage,
    compareFleetHandoffComputers,
    defaultFleetHandoffCheckoutMode,
    effectiveConsents,
    FLEET_AGENT_SESSION_PROVIDERS,
    FLEET_SESSION_PROVIDER_CAPABILITY,
    fleetHandoffAgentCli,
    fleetHandoffRepositoryOf,
    fleetRemotesMatch,
    judgeFleetHandoffComputer,
    parseFleetRemote,
    parseFleetTaskSourceLink,
    type FleetAgentSessionProvider,
    type FleetHandoffCandidateAgent,
    type FleetHandoffCheckoutRef,
    type FleetHandoffComputer,
    type FleetHandoffNodeCheckouts,
    type FleetTaskHandoffOptions,
} from '@ever-works/contracts';

/** The Node fields the hand-off reads. */
interface HandoffNode {
    id: string;
    userId: string;
    name: string;
    kind: string;
    status: string;
    platform?: string | null;
    capabilities: string[] | null;
    lastHeartbeatAt?: Date | null;
    consents?: unknown;
    workerState?: unknown;
    sessionDaemon?: unknown;
    effectiveMaxConcurrentJobs?: number | null;
}

/** The checkout fields the hand-off reads. */
interface HandoffCheckoutRow {
    id: string;
    nodeId: string;
    path: string;
    kind: FleetHandoffCheckoutRef['kind'];
    branch?: string | null;
    remoteUrl?: string | null;
    workId?: string | null;
    state: string;
    isolation?: string | null;
    updatedAt?: Date | null;
}

function iso(value: Date | string | null | undefined): string | null {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function describeAgo(since: Date | string | null | undefined, now: number): string | null {
    const at = iso(since);
    if (!at) return null;
    const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
    if (minutes < 90) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 36) return `${hours} h`;
    return `${Math.round(hours / 24)} d`;
}

/** The clone URL of a Work's Task repository on the providers the platform knows. */
function cloneUrlFor(gitProvider: string | null | undefined, owner: string, repo: string): string | null {
    const host =
        !gitProvider || gitProvider === 'github'
            ? 'github.com'
            : gitProvider === 'gitlab'
              ? 'gitlab.com'
              : null;
    if (!host || !owner || !repo) return null;
    return `https://${host}/${owner}/${repo}.git`;
}

/**
 * Tasks on computers (FL-15 P1) — `GET /api/fleet/tasks/:taskId/handoff-options`:
 * everything the **Fix with an agent on this computer** dialog shows, in one
 * read (spec FR-2 … FR-8, plan §5).
 *
 *  - the Agent candidates **Run with agent** offers, by the SAME resolver
 *    (`TasksService.listRunCandidates`, FR-4), each with its CLI, model and
 *    pinned computer;
 *  - every computer the person may see, judged for the selected Agent by
 *    FL-04's start rules plus the pin and the slot — the one
 *    `judgeFleetHandoffComputer` the start path judges by;
 *  - per computer, the checkouts of the Task's repository (new worktree
 *    parents), the others (U7) and the default choice (FR-5);
 *  - the prefilled first message (FR-7).
 *
 * A read only: nothing is written, the pin least of all (FR-3). A missing
 * Task — or one the person may not see — is the 404 `TasksService.getOne`
 * answers.
 */
@Injectable()
export class FleetTaskHandoffService {
    private readonly logger = new Logger(FleetTaskHandoffService.name);
    private readonly now: () => number = () => Date.now();

    constructor(
        private readonly tasks: TasksService,
        private readonly works: WorkRepository,
        private readonly agents: AgentRepository,
        private readonly runs: AgentRunRepository,
        private readonly nodes: FleetNodeRepository,
        private readonly access: FleetAccessService,
        private readonly killSwitch: FleetKillSwitchService,
        private readonly sessions: FleetSessionRepository,
        private readonly sessionTasks: FleetSessionTaskService,
        private readonly checkouts: FleetCheckoutRepository,
        @Optional() @Inject(FLEET_SESSION_NODE_PORT) private readonly link?: FleetSessionNodePort,
    ) {}

    async options(
        userId: string,
        taskId: string,
        requestedAgentId: string | null,
        scope?: OwnershipScope,
    ): Promise<FleetTaskHandoffOptions> {
        const task = await this.tasks.getOne(userId, taskId, scope);
        const work = task.workId ? await this.works.findById(task.workId).catch(() => null) : null;
        const target = work ? resolveTaskRepository(work) : null;
        const repoUrl = target ? cloneUrlFor(work?.gitProvider, target.owner, target.repo) : null;
        const repository = repoUrl ? fleetHandoffRepositoryOf(repoUrl) : null;
        const branch =
            typeof task.branchRef === 'string' && task.branchRef.trim()
                ? task.branchRef.trim()
                : task.workId
                  ? taskBranchName(task)
                  : null;
        const source = parseFleetTaskSourceLink(task.description ?? '');

        // ── Agents (FR-4): the Run-with-agent resolver, then each Agent's facts.
        const candidates = await this.tasks.listRunCandidates(userId, taskId, scope).catch(() => []);
        const ownNodes = ((await this.nodes.findByUser(userId)) as unknown as HandoffNode[]).filter(
            (node) => node.status !== 'enrolling' && node.kind !== 'k8s',
        );
        const nodeNames = new Map(ownNodes.map((node) => [node.id, node.name]));
        const agents: FleetHandoffCandidateAgent[] = [];
        for (const candidate of candidates) {
            const agent = await this.agents.findByIdAndUser(candidate.id, userId, scope).catch(() => null);
            if (!agent) continue;
            const pinnedNodeId = await this.sessionTasks.pinnedNodeId(userId, {
                id: agent.id,
                name: agent.name,
                organizationId: agent.organizationId ?? null,
            });
            agents.push({
                id: agent.id,
                name: agent.name,
                slug: agent.slug ?? null,
                status: agent.status ?? null,
                source: candidate.source,
                cli: fleetHandoffAgentCli(agent),
                modelId: agent.modelId ?? null,
                pinnedNodeId,
                pinnedNodeName: pinnedNodeId ? (nodeNames.get(pinnedNodeId) ?? null) : null,
            });
        }
        const selected =
            agents.find((agent) => agent.id === requestedAgentId) ?? agents[0] ?? null;

        // ── Computers (FR-2, FR-3, U1–U6).
        const killSwitchOn = await this.killSwitch.isStopped().catch(() => true);
        const now = this.now();
        const computers: FleetHandoffComputer[] = [];
        for (const node of ownNodes) {
            computers.push(await this.judge(node, selected, killSwitchOn, now));
        }
        try {
            for (const { node } of await this.access.listSharedWith(userId)) {
                const shared = node as unknown as HandoffNode;
                if (shared.kind === 'k8s' || computers.some((row) => row.nodeId === shared.id)) continue;
                computers.push({
                    ...this.describe(shared),
                    selectable: false,
                    reason: 'no-access',
                    hint: `Agent sessions run on your own computers for now; ${shared.name} belongs to someone else`,
                    pinned: false,
                    liveAgentSessions: 0,
                    slots: null,
                });
            }
        } catch (error) {
            this.logger.debug(
                `Shared computers for ${userId} not read: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        computers.sort(compareFleetHandoffComputers);

        // ── Checkouts (FR-5, U7).
        const checkouts: FleetHandoffNodeCheckouts[] = [];
        for (const node of ownNodes) {
            checkouts.push(await this.checkoutsOn(node, task.workId ?? null, repoUrl));
        }

        // ── First message (FR-7) and the session already working it (U13).
        const checks = (task.acceptanceChecks ?? [])
            .filter((check) => check && (check as { disabled?: boolean }).disabled !== true)
            .map((check) => check.name)
            .filter((name): name is string => typeof name === 'string' && name.length > 0);
        const firstMessage = buildFleetTaskFirstMessage({
            slug: task.slug,
            title: task.title,
            description: task.description ?? null,
            checks,
            source,
            branch,
            hasRepository: repository !== null,
        });
        let activeSessionId: string | null = null;
        if (selected) {
            const inflight = await this.runs.findInFlightForTaskAgent(task.id, selected.id).catch(() => null);
            activeSessionId = (inflight as { fleetSessionId?: string | null } | null)?.fleetSessionId ?? null;
        }

        return {
            task: {
                id: task.id,
                slug: task.slug,
                title: task.title,
                status: task.status,
                workId: task.workId ?? null,
                branch,
                repository,
                repoUrl,
                source,
            },
            agents,
            agentId: selected?.id ?? null,
            computers,
            checkouts,
            firstMessage,
            killSwitch: killSwitchOn,
            activeSessionId,
        };
    }

    /** One of the person's own computers, judged for the Agent. */
    private async judge(
        node: HandoffNode,
        agent: FleetHandoffCandidateAgent | null,
        killSwitchOn: boolean,
        now: number,
    ): Promise<FleetHandoffComputer> {
        const base = this.describe(node);
        const liveAgentSessions = await this.sessions.countLiveAgentForNode(node.id).catch(() => 0);
        const slots = typeof node.effectiveMaxConcurrentJobs === 'number' ? node.effectiveMaxConcurrentJobs : null;
        const cli: FleetAgentSessionProvider = agent?.cli ?? 'claude-code';
        const refusal = canStartFleetSession({
            node: {
                name: node.name,
                status: node.status,
                kind: node.kind,
                capabilities: node.capabilities ?? [],
                lastHeartbeatAt: node.lastHeartbeatAt ?? null,
                sessionDaemon: (node.sessionDaemon ?? null) as never,
            },
            consents:
                this.link?.liveConsents(node.id) ??
                effectiveConsents({
                    consents: node.consents as never,
                    capabilities: node.capabilities,
                    workerState: node.workerState as never,
                }),
            kind: 'agent',
            provider: cli,
            killSwitchOn,
            linkConnected: base.online,
            liveOwnerSessions: [],
            lastSeenAgo: describeAgo(node.lastHeartbeatAt ?? null, now),
        });
        const verdict = judgeFleetHandoffComputer({
            nodeId: node.id,
            nodeName: node.name,
            refusal: refusal ? { code: refusal.code, hint: refusal.hint } : null,
            pinnedNodeId: agent?.pinnedNodeId ?? null,
            pinnedNodeName: agent?.pinnedNodeName ?? null,
            agentName: agent?.name ?? 'The Agent',
            liveAgentSessions,
            slots,
        });
        return {
            ...base,
            selectable: agent !== null && verdict.selectable,
            reason: verdict.reason,
            hint: agent === null ? 'Assign an Agent to this Task first' : verdict.hint,
            pinned: agent?.pinnedNodeId === node.id,
            liveAgentSessions,
            slots,
        };
    }

    private describe(
        node: HandoffNode,
    ): Pick<FleetHandoffComputer, 'nodeId' | 'name' | 'online' | 'lastSeenAt' | 'os' | 'clis'> {
        const tags = node.capabilities ?? [];
        return {
            nodeId: node.id,
            name: node.name,
            online: this.link?.isConnected(node.id) ?? false,
            lastSeenAt: iso(node.lastHeartbeatAt ?? null),
            os: typeof node.platform === 'string' && node.platform ? node.platform : null,
            clis: FLEET_AGENT_SESSION_PROVIDERS.filter((provider) => {
                const tag = FLEET_SESSION_PROVIDER_CAPABILITY[provider];
                return tag !== null && tags.includes(tag);
            }),
        };
    }

    /** One computer's checkout step (FR-5, U7): ready, host-isolated checkouts only. */
    private async checkoutsOn(
        node: HandoffNode,
        workId: string | null,
        repoUrl: string | null,
    ): Promise<FleetHandoffNodeCheckouts> {
        let rows: HandoffCheckoutRow[] = [];
        let stale: string | null = null;
        try {
            rows = (await this.checkouts.findForNode(node.id)) as unknown as HandoffCheckoutRow[];
        } catch (error) {
            stale = `the checkouts on ${node.name} could not be read`;
            this.logger.debug(
                `Checkouts of ${node.id} not read: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        const matching: FleetHandoffCheckoutRef[] = [];
        const others: FleetHandoffCheckoutRef[] = [];
        const usable = rows
            .filter((row) => row.state === 'ready' && row.isolation !== 'container')
            .sort((a, b) => (iso(b.updatedAt ?? null) ?? '').localeCompare(iso(a.updatedAt ?? null) ?? ''));
        for (const row of usable) {
            const matches =
                (workId !== null && row.workId === workId) ||
                (repoUrl !== null && fleetRemotesMatch(row.remoteUrl ?? null, repoUrl));
            const parsed = parseFleetRemote(row.remoteUrl ?? null);
            const ref: FleetHandoffCheckoutRef = {
                checkoutId: row.id,
                path: row.path,
                kind: row.kind,
                branch: row.branch ?? null,
                repository: parsed ? `${parsed.owner}/${parsed.repo}` : null,
                matchesTask: matches,
            };
            (matches ? matching : others).push(ref);
        }
        return {
            nodeId: node.id,
            matching,
            others,
            defaultMode: defaultFleetHandoffCheckoutMode({
                hasRepository: repoUrl !== null,
                matching: matching.length,
                others: others.length,
            }),
            stale,
        };
    }
}
