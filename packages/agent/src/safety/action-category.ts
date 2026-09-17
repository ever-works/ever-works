import {
    isActionCategory,
    matchesAnyToolPattern,
    moreRestrictiveCategory,
    type ActionCategory,
} from '@ever-works/contracts';

/**
 * Safety rails (AW-24) — classification: which KIND OF WORK is this?
 *
 * The classifier is a TOTAL function (FR-3). An action with no mapping is not
 * "allowed" and not "denied" — it is `null`, and `null` is handled once, by
 * the gate, according to the published unclassified policy. Nothing here ever
 * guesses a permissive category.
 *
 * ## The one rule that makes this a safety property
 *
 * Classification is decided from the action's OWN ENTRY POINT, never from
 * anything the model supplies as an argument (FR-4). At the tool choke point
 * the entry point is the descriptor the platform resolved — the model's
 * `call.name` only matters because it had to resolve to a descriptor the
 * platform itself built, and an unresolvable name never reaches this function
 * at all. No tool argument, instruction, skill body, memory fact or knowledge
 * document is an input.
 *
 * ## No plugin ids in core
 *
 * A plugin-exposed tool is classified from the PLUGIN'S OWN manifest
 * declaration, passed in as `manifestCategories`, never from a table in this
 * file (Constitution II). The glob semantics are
 * `matchesAnyToolPattern` from the tool-grant contract, reused rather than
 * re-implemented so pattern behaviour cannot drift between the two.
 */

/**
 * The platform's own entry points, keyed by entry-point id.
 *
 * Tool entry points are keyed by the tool name the platform registers — it is
 * the descriptor's identity, not a model-supplied value. Non-tool entry
 * points (facades, controllers, dispatchers reached from an API route rather
 * than from the tool loop) are keyed `facade:<name>` so the two namespaces
 * cannot collide.
 *
 * A category listed here is a promise the rest of the epic keeps: every
 * laddered category has at least one entry point, asserted by
 * `entry-point-coverage.spec.ts`, so no rung can be a setting that governs
 * nothing.
 */
export const ENTRY_POINT_CATEGORY: Readonly<Record<string, ActionCategory>> = Object.freeze({
    // ── read.internal — reading what is already inside the workspace ──
    // Not laddered (FR-2): connections and tool grants decide this, and a
    // second way to express it would be a second thing to get wrong.
    getActivity: 'read.internal',
    getKbDocument: 'read.internal',
    getSkillBody: 'read.internal',
    getSkillFile: 'read.internal',
    list_escalations: 'read.internal',
    list_fleet_nodes: 'read.internal',
    list_meetings: 'read.internal',
    get_meeting_summary: 'read.internal',
    list_recent_events: 'read.internal',
    get_digest: 'read.internal',
    resolve_tool_grants: 'read.internal',
    check_tool_grant: 'read.internal',
    resolve_merge_policy: 'read.internal',
    validate_workflow_graph: 'read.internal',

    // ── read.external — browse the web ──
    searchWeb: 'read.external',
    browse_url: 'read.external',
    screenshot: 'read.external',
    extractContent: 'read.external',
    'facade:search': 'read.external',
    'facade:screenshot': 'read.external',
    'facade:content-extractor': 'read.external',

    // ── write.internal — create and update things inside the workspace ──
    createTask: 'write.internal',
    commentOnTask: 'write.internal',
    transitionTask: 'write.internal',
    submitTaskReview: 'write.internal',
    editAgentFile: 'write.internal',
    resolve_escalation: 'write.internal',
    review_pull_request: 'write.internal',
    run_workflow_graph: 'write.internal',
    'facade:memory-write': 'write.internal',
    'facade:knowledge-write': 'write.internal',

    // ── write.destructive — removing data with no preserved copy ──
    'facade:hard-delete': 'write.destructive',
    'facade:force-push': 'write.destructive',

    // ── message.internal — workspace members and other agents ──
    messageAgent: 'message.internal',
    ask_human: 'message.internal',
    'facade:inbox-message': 'message.internal',

    // ── message.external — delivered to a person outside the workspace ──
    sendEmail: 'message.external',
    notifyChannel: 'message.external',
    'facade:agent-email-send': 'message.external',
    'facade:notify-channel': 'message.external',

    // ── publish.external — deploy, publish, merge, open a public PR ──
    commitToRepo: 'publish.external',
    openPullRequest: 'publish.external',
    'facade:git-merge': 'publish.external',
    'facade:pull-request-gate': 'publish.external',
    'facade:deploy': 'publish.external',

    // ── spend.metered — anything that debits credits or provider spend ──
    'facade:model-dispatch': 'spend.metered',
    'facade:plugin-operation': 'spend.metered',

    // ── spend.commitment — money in the real world. No entry point exists,
    // and FR-12 says none ever may. The key is declared so the coverage
    // spec can assert the category is known and permanently unreachable.
    'facade:never-purchase': 'spend.commitment',

    // ── access.grant — widening any access ──
    'facade:tool-grant-write': 'access.grant',
    'facade:connection-write': 'access.grant',
    'facade:autonomy-grant-write': 'access.grant',

    // ── machine.run — commands in the agent's own workspace directory ──
    'facade:terminal-session': 'machine.run',
    'facade:fleet-job-dispatch': 'machine.run',

    // ── machine.admin — changing a computer ──
    'facade:node-admin': 'machine.admin',
    'facade:computer-control': 'machine.admin',

    // ── agent.fanout — hiring agents, setting schedules ──
    createSubAgent: 'agent.fanout',
    delegateToAgent: 'agent.fanout',
    'facade:schedule-write': 'agent.fanout',
    'facade:trigger-write': 'agent.fanout',
} as Record<string, ActionCategory>);

/** What the classifier may look at beyond the entry-point id itself. */
export interface ClassifyActionHints {
    /** The plugin exposing this tool, when one does. Used for reporting only. */
    pluginId?: string | null;
    /** The registered tool name, when the entry point is a tool call. */
    toolName?: string | null;
    /**
     * The plugin's OWN manifest declaration: tool-name pattern → category.
     * Supplied by the caller that loaded the manifest; core never holds a
     * plugin id (Constitution II).
     */
    manifestCategories?: Readonly<Record<string, string>> | null;
}

/**
 * Which kind of work is this? `null` when nothing classified it.
 *
 * Resolution order, first answer wins:
 *   1. the platform's own entry point map;
 *   2. the plugin manifest declaration, glob-matched on the tool name;
 *   3. `null` — unclassified.
 *
 * Where a manifest declares two patterns that both match, the MORE
 * RESTRICTIVE category wins (FR-6) — a published order rather than a
 * judgement call, so two call sites cannot disagree about which of two
 * categories is the safer answer.
 */
export function classifyAction(
    entryPointId: string,
    hints: ClassifyActionHints = {},
): ActionCategory | null {
    const platform = ENTRY_POINT_CATEGORY[entryPointId];
    if (platform) return platform;

    const toolName = hints.toolName ?? entryPointId;
    const declared = hints.manifestCategories;
    if (!declared || !toolName) return null;

    let resolved: ActionCategory | null = null;
    for (const [pattern, category] of Object.entries(declared)) {
        // An id this build does not know is not a category. A manifest that
        // names one is treated as having declared nothing for that pattern,
        // never as having declared something permissive.
        if (!isActionCategory(category)) continue;
        if (!matchesAnyToolPattern([pattern], toolName)) continue;
        resolved = resolved === null ? category : moreRestrictiveCategory(resolved, category);
    }
    return resolved;
}

/** Every entry-point id the platform classifies, for the coverage assertion. */
export function knownEntryPoints(): readonly string[] {
    return Object.keys(ENTRY_POINT_CATEGORY);
}
