import { isAppWorkKind } from '@ever-works/contracts';

import { classifyAction, knownEntryPoints } from '../safety/action-category';

/**
 * APW-08 T47 (XC-05, FR-69) — the App Work Task tool policy.
 *
 * An App Work run works on **third-party code**: the fork's instruction files, build failure
 * excerpts, and later upstream `CONTRIBUTING` files and reviewer comments all reach the model.
 * The run's own sandbox does not cover the platform-side tools (they run in the API, outside it),
 * so a repository that can steer the model could otherwise steer those tools: mail someone,
 * fetch a URL with the run's data in it, call an MCP server, raise another Agent, or change the
 * platform's own App Works. This file is the one list that says what such a run never receives
 * (CONTRACTS §3, APW-08 row): APW-09 consumes it for its upstream-PR preparation runs and declares
 * no second list.
 *
 * ## An allow-list, reported in groups
 *
 * The spec names the groups a run is denied; it also says `ask_human` and the read-only tools
 * stay. Read together, everything else that ACTS is not part of an App Work run, so the decision
 * is made as an allow-list and the denied groups are the names a refusal is reported under:
 *
 * 1. {@link APP_WORK_TASK_ALWAYS_ALLOWED_TOOLS} (`ask_human`) is always kept — asking the owner
 *    grants nothing and touches nothing.
 * 2. Every `mcp__<server>__<tool>` name is denied as `mcp`, whatever the server says it does.
 * 3. A tool named in {@link APP_WORK_TASK_DENIED_TOOLS_BY_GROUP} is denied under that group.
 * 4. {@link APP_WORK_TASK_ALLOWED_ACTING_TOOLS} are kept: the run's own repository tools, which the
 *    change guard and the merge gate judge (`commitToRepo`, `openPullRequest`), and the review
 *    verdict a review run answers its own review with (`submitTaskReview`).
 * 5. A tool the platform classifies `read.internal` (reading what is already in the workspace) is
 *    kept.
 * 6. Anything else is denied — by its platform category when that names a group
 *    (`read.external` → `web-fetch`, `message.*` → `outbound-messaging`, `agent.fanout` →
 *    `sub-agent`), and otherwise as `platform-action`. An unclassified tool lands here too: a
 *    tool added tomorrow is withheld from App Work runs until someone classifies it, instead of
 *    reaching them by default.
 *
 * `platform-action` is the sixth group, an addition to the five the spec lists (lane B2,
 * 2026-10-27): it is where the acting tools the spec's groups do not name end up — the computer
 * acts of the fleet catalogue, an agent-file edit, a schedule. Recorded as an owner question in
 * the lane log; removing it would widen the policy, never narrow it.
 *
 * ## Names are compared case-insensitively
 *
 * The tool-grant matrix matches names case-insensitively (`matchesToolPattern`), so this file does
 * too: a policy that missed `SendEmail` while the grant matrix allowed it would be a bypass.
 *
 * 🛑 **A leaf file.** It imports the contracts and the action classifier only, so
 * `AgentToolService`, `AgentRunService`, the fleet planner and APW-09 can all import it without
 * closing a require ring.
 */

/** FR-69 — the groups an App Work run is denied, in the order a refusal reports them. */
export const APP_WORK_TASK_DENIED_TOOL_GROUPS = [
    'outbound-messaging',
    'web-fetch',
    'mcp',
    'sub-agent',
    'app-works-mutation',
    'platform-action',
] as const;

export type AppWorkTaskDeniedToolGroup = (typeof APP_WORK_TASK_DENIED_TOOL_GROUPS)[number];

/** The one tool the policy always keeps, whatever else it denies. */
export const APP_WORK_TASK_ALWAYS_ALLOWED_TOOLS = ['ask_human'] as const;

/**
 * Tools that act and are still part of an App Work run: the run's own branch and pull request
 * (judged by the change guard before they publish and by the merge gate after), and a review
 * run's verdict on its own review (the tool authorizes on the run row, never the model).
 */
export const APP_WORK_TASK_ALLOWED_ACTING_TOOLS = [
    'commitToRepo',
    'openPullRequest',
    'submitTaskReview',
] as const;

/** The prefix every MCP-sourced tool name carries (`mcp__<server>__<tool>`). */
export const APP_WORK_TASK_MCP_TOOL_PREFIX = 'mcp__';

/**
 * The tools the platform exposes today that each group names, so a refusal is reported under the
 * group the spec uses for it. Names that no platform tool carries today (`create_work`,
 * `provisionAppWork`, the deploy / env / target / upstream-PR verbs) are listed because the spec
 * names them: if one is ever built as an Agent tool it is denied here from its first day.
 */
export const APP_WORK_TASK_DENIED_TOOLS_BY_GROUP: Readonly<
    Record<Exclude<AppWorkTaskDeniedToolGroup, 'mcp' | 'platform-action'>, readonly string[]>
> = Object.freeze({
    'outbound-messaging': [
        'sendEmail',
        'messageAgent',
        'notifyChannel',
        // A comment on ANOTHER Task's thread wakes that Task's Agent — an agent-to-agent message.
        // The run's own reply is posted to its Task by the platform when the run finishes.
        'commentOnTask',
        'fleet_sessions_send',
        'fleet_sessions_answer',
    ],
    'web-fetch': ['searchWeb', 'screenshot', 'extractContent', 'browse_url', 'review_pull_request'],
    'sub-agent': [
        'createSubAgent',
        'delegateToAgent',
        'run_workflow_graph',
        // Raising or moving another Task starts another Agent's run — delegation by another name.
        // A task-kind run still finishes its OWN Task: `AgentRunService` adds that virtual
        // `transitionTask` after this policy, and it only records the run's intent.
        'createTask',
        'transitionTask',
        'fleet_sessions_start',
    ],
    'app-works-mutation': [
        'request_app_change',
        'create_work',
        'delete_work',
        'provisionAppWork',
        'provision_app_work',
        'deploy_app',
        'redeploy_app',
        'set_app_env',
        'update_app_env',
        'set_app_target',
        'update_app_target',
        'open_upstream_pr',
        'open_upstream_pull_request',
    ],
});

/** Why a tool was withheld: the group, never the tool's arguments. */
export interface AppWorkTaskToolDenial {
    toolName: string;
    group: AppWorkTaskDeniedToolGroup;
}

/**
 * One decision. A flat shape rather than a discriminated union on purpose: this package compiles
 * with `strictNullChecks: false`, where narrowing on `allowed` does not narrow, so `group` is
 * always present — `null` exactly when the tool is kept.
 */
export interface AppWorkTaskToolDecision {
    allowed: boolean;
    toolName: string;
    group: AppWorkTaskDeniedToolGroup | null;
}

const keep = (toolName: string): AppWorkTaskToolDecision => ({
    allowed: true,
    toolName,
    group: null,
});
const deny = (toolName: string, group: AppWorkTaskDeniedToolGroup): AppWorkTaskToolDecision => ({
    allowed: false,
    toolName,
    group,
});

const lower = (name: string): string => name.trim().toLowerCase();

const ALWAYS_ALLOWED = new Set(APP_WORK_TASK_ALWAYS_ALLOWED_TOOLS.map(lower));
const ALLOWED_ACTING = new Set(APP_WORK_TASK_ALLOWED_ACTING_TOOLS.map(lower));
const GROUP_BY_TOOL: ReadonlyMap<string, AppWorkTaskDeniedToolGroup> = new Map(
    (
        Object.entries(APP_WORK_TASK_DENIED_TOOLS_BY_GROUP) as Array<
            [AppWorkTaskDeniedToolGroup, readonly string[]]
        >
    ).flatMap(([group, names]) => names.map((name) => [lower(name), group] as const)),
);

/**
 * The platform's category for a tool, matched case-insensitively. `classifyAction` keys on the
 * exact registered name, so a differently-cased name is looked up by its canonical spelling.
 */
const CANONICAL_NAME: ReadonlyMap<string, string> = new Map(
    knownEntryPoints()
        .filter((name) => !name.startsWith('facade:'))
        .map((name) => [lower(name), name] as const),
);
function categoryOf(toolName: string): ReturnType<typeof classifyAction> {
    const exact = classifyAction(toolName, { toolName });
    if (exact) return exact;
    const canonical = CANONICAL_NAME.get(lower(toolName));
    return canonical ? classifyAction(canonical, { toolName: canonical }) : null;
}

/** What FR-69 decides for one tool name on an App Work run. */
export function decideAppWorkTaskTool(toolName: string): AppWorkTaskToolDecision {
    const key = lower(toolName);
    if (ALWAYS_ALLOWED.has(key)) return keep(toolName);
    if (key.startsWith(APP_WORK_TASK_MCP_TOOL_PREFIX)) return deny(toolName, 'mcp');
    const named = GROUP_BY_TOOL.get(key);
    if (named) return deny(toolName, named);
    if (ALLOWED_ACTING.has(key)) return keep(toolName);
    const category = categoryOf(toolName);
    if (category === 'read.internal') return keep(toolName);
    if (category === 'read.external') return deny(toolName, 'web-fetch');
    if (category === 'message.internal' || category === 'message.external') {
        return deny(toolName, 'outbound-messaging');
    }
    if (category === 'agent.fanout') return deny(toolName, 'sub-agent');
    return deny(toolName, 'platform-action');
}

/** Per-group counts of what a run was denied — the FR-69 counter (ACC-08-33). No tool arguments. */
export type AppWorkTaskToolPolicyCounts = Partial<Record<AppWorkTaskDeniedToolGroup, number>>;

export interface AppWorkTaskToolPolicyResult<T> {
    kept: T[];
    denied: AppWorkTaskToolDenial[];
    counts: AppWorkTaskToolPolicyCounts;
}

/** Split a resolved tool list into what an App Work run keeps and what FR-69 withholds. */
export function applyAppWorkTaskToolPolicy<T extends { name: string }>(
    tools: readonly T[],
): AppWorkTaskToolPolicyResult<T> {
    const kept: T[] = [];
    const denied: AppWorkTaskToolDenial[] = [];
    const counts: AppWorkTaskToolPolicyCounts = {};
    for (const tool of tools) {
        const decision = decideAppWorkTaskTool(tool.name);
        if (decision.allowed || decision.group === null) {
            kept.push(tool);
            continue;
        }
        const group = decision.group;
        denied.push({ toolName: decision.toolName, group });
        counts[group] = (counts[group] ?? 0) + 1;
    }
    return { kept, denied, counts };
}

/**
 * The dispatch re-check: the names in a run's final list that FR-69 denies. Empty means the list
 * honours the policy; anything else means a path widened it after the policy ran, and the run is
 * refused rather than started.
 */
export function findAppWorkTaskToolPolicyViolations(
    toolNames: readonly string[],
): AppWorkTaskToolDenial[] {
    const out: AppWorkTaskToolDenial[] = [];
    for (const name of toolNames) {
        const decision = decideAppWorkTaskTool(name);
        if (!decision.allowed && decision.group !== null) {
            out.push({ toolName: decision.toolName, group: decision.group });
        }
    }
    return out;
}

/** Stable code a refused App Work run carries on its run row and log (no tool arguments). */
export const APP_WORK_TOOL_POLICY_REFUSAL_CODE = 'app_work_tool_policy';

/** The run-row message for a dispatch the re-check refused. Names the groups, never arguments. */
export function describeAppWorkTaskToolPolicyRefusal(
    violations: readonly AppWorkTaskToolDenial[],
): string {
    const groups = [...new Set(violations.map((violation) => violation.group))];
    return (
        `${APP_WORK_TOOL_POLICY_REFUSAL_CODE}: this run works on an App Work, and its tool list still held ` +
        `${violations.length} tool(s) the App Work Task tool policy denies (${groups.join(', ')}), so it was ` +
        'refused before it started. An App Work run never receives outbound messaging, web fetch, MCP, ' +
        'sub-agent or App Works mutation tools.'
    );
}

/**
 * The FR-69 policy, as one published object (CONTRACTS §3, APW-08 row). APW-09 imports this.
 */
export const APP_WORK_TASK_TOOL_POLICY = Object.freeze({
    deniedGroups: APP_WORK_TASK_DENIED_TOOL_GROUPS,
    alwaysAllowed: APP_WORK_TASK_ALWAYS_ALLOWED_TOOLS,
    allowedActing: APP_WORK_TASK_ALLOWED_ACTING_TOOLS,
    mcpToolPrefix: APP_WORK_TASK_MCP_TOOL_PREFIX,
    deniedToolsByGroup: APP_WORK_TASK_DENIED_TOOLS_BY_GROUP,
    decide: decideAppWorkTaskTool,
    apply: applyAppWorkTaskToolPolicy,
    findViolations: findAppWorkTaskToolPolicyViolations,
});

/**
 * When FR-69 applies to a run (spec: "every App Work run whichever surface started it").
 *
 * - The run executes a Task on an App Work (a board, chat, Goal, Mission or follow-up Task alike),
 *   including the Task's own chat replies — the thread carries build excerpts and repository text.
 * - Or the run's Agent is scoped to an App Work and the run is anything but its owner's own
 *   Conversation turn: a heartbeat or a delegated run recalls what earlier App Work runs read, and
 *   the owner's turn is the one place `request_app_change` starts a change on purpose.
 *
 * Kinds are the raw `work.kind` values; `isAppWorkKind` normalizes them.
 */
export function appWorkTaskToolPolicyApplies(input: {
    taskWorkKind?: string | null;
    agentWorkKind?: string | null;
    ownerConversationTurn?: boolean;
}): boolean {
    if (isAppWorkKind(input.taskWorkKind)) return true;
    if (isAppWorkKind(input.agentWorkKind) && input.ownerConversationTurn !== true) return true;
    return false;
}
