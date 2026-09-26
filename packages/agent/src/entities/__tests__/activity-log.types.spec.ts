import {
    ActivityActionType,
    ActivityStatus,
    type CreateActivityLogDto,
    type ActivityLogQueryOptions,
} from '../activity-log.types';

/**
 * `activity-log.types.ts` defines the contract that gets written into
 * `activity_log` rows and queried back from `/api/activity-log/*` endpoints.
 * Every enum literal here is matched via string equality across the
 * codebase (e.g. listener filter chains, DB queries, API DTOs), so a
 * silent rename is a backwards-incompat break for every persisted row.
 */
describe('activity-log.types', () => {
    describe('ActivityActionType — pinned literal values', () => {
        // Pin every documented literal so a rename surfaces in the test
        // diff. The values are persisted in DB rows and matched via string
        // equality across the codebase.
        const cases: Array<[keyof typeof ActivityActionType, string]> = [
            // Generation
            ['GENERATION', 'generation'],
            ['COMPARISON_GENERATION', 'comparison_generation'],
            // Deployment
            ['DEPLOYMENT', 'deployment'],
            // Work lifecycle
            ['WORK_CREATED', 'work_created'],
            ['WORK_UPDATED', 'work_updated'],
            ['WORK_DELETED', 'work_deleted'],
            // Items
            ['ITEM_ADDED', 'item_added'],
            ['ITEM_UPDATED', 'item_updated'],
            ['ITEM_REMOVED', 'item_removed'],
            // Plugins
            ['PLUGIN_ENABLED', 'plugin_enabled'],
            ['PLUGIN_DISABLED', 'plugin_disabled'],
            ['PLUGIN_CONFIGURED', 'plugin_configured'],
            // Templates
            ['TEMPLATE_ADDED', 'template_added'],
            ['TEMPLATE_UPDATED', 'template_updated'],
            ['TEMPLATE_ARCHIVED', 'template_archived'],
            ['TEMPLATE_FORKED', 'template_forked'],
            ['TEMPLATE_DEFAULT_SET', 'template_default_set'],
            // Members
            ['MEMBER_INVITED', 'member_invited'],
            ['MEMBER_ROLE_CHANGED', 'member_role_changed'],
            ['MEMBER_REMOVED', 'member_removed'],
            // Schedule
            ['SCHEDULE_CREATED', 'schedule_created'],
            ['SCHEDULE_UPDATED', 'schedule_updated'],
            ['SCHEDULE_DELETED', 'schedule_deleted'],
            ['SCHEDULE_EXECUTED', 'schedule_executed'],
            ['SCHEDULE_PAUSED', 'schedule_paused'],
            ['SCHEDULE_RESUMED', 'schedule_resumed'],
            // Import / Export
            ['IMPORT', 'import'],
            ['EXPORT', 'export'],
            // Settings
            ['SETTINGS_UPDATED', 'settings_updated'],
            ['WEBSITE_SETTINGS_UPDATED', 'website_settings_updated'],
            ['PROMPTS_UPDATED', 'prompts_updated'],
            ['WORKS_CONFIG_SYNC', 'works_config_sync'],
            // Auth / Account
            ['USER_LOGIN', 'user_login'],
            ['USER_SIGNUP', 'user_signup'],
            ['PROVIDER_CONNECTED', 'provider_connected'],
            ['PASSWORD_CHANGED', 'password_changed'],
            // Chat / AI
            ['CHAT_CONVERSATION', 'chat_conversation'],
            // Community
            ['COMMUNITY_PR_MERGED', 'community_pr_merged'],
            // Git activity ingestion (audit item j) — pushes, the commits
            // inside them, and merged pull requests, landed by the GitHub
            // receiver through the event-ingest spine.
            ['GIT_PUSHED', 'git_pushed'],
            ['GIT_COMMITTED', 'git_committed'],
            ['GIT_MERGED', 'git_merged'],
            // MCP connections (agent-plugins MCP slice, plan §2.4) — manual
            // connection lifecycle + per-agent binding changes.
            ['MCP_CONNECTION_CREATED', 'mcp_connection_created'],
            ['MCP_CONNECTION_UPDATED', 'mcp_connection_updated'],
            ['MCP_CONNECTION_DELETED', 'mcp_connection_deleted'],
            ['MCP_CONNECTION_TESTED', 'mcp_connection_tested'],
            ['MCP_BINDING_UPDATED', 'mcp_binding_updated'],
            // Agent Collaborators — sub-agent delegation allow-list edits.
            ['AGENT_COLLABORATOR_ENABLED', 'agent_collaborator_enabled'],
            ['AGENT_COLLABORATOR_DISABLED', 'agent_collaborator_disabled'],
            ['AGENT_COLLABORATOR_REMOVED', 'agent_collaborator_removed'],
            // Memory facts + context files (AW-07).
            ['MEMORY_FACT_CREATED', 'memory_fact_created'],
            ['MEMORY_FACT_UPDATED', 'memory_fact_updated'],
            ['MEMORY_FACT_FORGOTTEN', 'memory_fact_forgotten'],
            ['MEMORY_FACT_RESTORED', 'memory_fact_restored'],
            ['MEMORY_FACT_ACCEPTED', 'memory_fact_accepted'],
            ['MEMORY_FACT_DISCARDED', 'memory_fact_discarded'],
            ['MEMORY_FACTS_CLEARED', 'memory_facts_cleared'],
            ['CONTEXT_FILE_UPDATED', 'context_file_updated'],
            ['CONTEXT_FILE_RESTORED', 'context_file_restored'],
            ['CONTEXT_FILE_MODE_CHANGED', 'context_file_mode_changed'],
            ['CONTEXT_BUDGET_EXCEEDED', 'context_budget_exceeded'],
            // Model accounts (AW-16) — provider account + model default changes.
            ['MODEL_ACCOUNT_ADDED', 'model_account_added'],
            ['MODEL_ACCOUNT_UPDATED', 'model_account_updated'],
            ['MODEL_ACCOUNT_REORDERED', 'model_account_reordered'],
            ['MODEL_ACCOUNT_PAUSED', 'model_account_paused'],
            ['MODEL_ACCOUNT_RESUMED', 'model_account_resumed'],
            ['MODEL_ACCOUNT_RECONNECTED', 'model_account_reconnected'],
            ['MODEL_ACCOUNT_REMOVED', 'model_account_removed'],
            ['MODEL_POLICY_UPDATED', 'model_policy_updated'],
            // Skills shelf — the workspace-level on/off switch.
            ['SKILL_ENABLED', 'skill_enabled'],
            ['SKILL_DISABLED', 'skill_disabled'],
            // Knowledge library — shelf curation (filing, archive, export)
            // and shared-folder rename.
            ['KB_DOCUMENT_ARCHIVED', 'kb_document_archived'],
            ['KB_DOCUMENT_UNARCHIVED', 'kb_document_unarchived'],
            ['KB_DOCUMENT_FILED', 'kb_document_filed'],
            ['KB_DOCUMENT_EXPORTED', 'kb_document_exported'],
            ['MEMORY_FOLDER_RENAMED', 'memory_folder_renamed'],
            // Live Feed — a run starting / finishing / failing for every
            // trigger kind other than heartbeat.
            ['AGENT_RUN_STARTED', 'agent_run_started'],
            ['AGENT_RUN_COMPLETED', 'agent_run_completed'],
            ['AGENT_RUN_FAILED', 'agent_run_failed'],
            // Shared view (AW-18)
            ['SHARED_VIEW_ENABLED', 'shared_view_enabled'],
            ['SHARED_VIEW_DISABLED', 'shared_view_disabled'],
            ['SHARED_VIEW_REGENERATED', 'shared_view_regenerated'],
            ['SHARED_VIEW_SECTIONS_CHANGED', 'shared_view_sections_changed'],
            ['SHARED_VIEW_INDEXING_CHANGED', 'shared_view_indexing_changed'],
            // Agent computers — one row per stretch of control of an Agent's machine.
            ['AGENT_COMPUTER_CONTROLLED', 'agent_computer_controlled'],
            // AW-22 Workspace backup — starting one, taking a copy off the
            // platform, and removing the bytes early.
            ['WORKSPACE_BACKUP_CREATED', 'workspace_backup_created'],
            ['WORKSPACE_BACKUP_DOWNLOADED', 'workspace_backup_downloaded'],
            ['WORKSPACE_BACKUP_DELETED', 'workspace_backup_deleted'],
            // APW-11 App Launcher (T7) — the Work-level **Show in App
            // Launcher** setting changed.
            ['APP_LAUNCHER', 'app_launcher'],
            // APW-02 Fork lifecycle (T15, Resolution R-2) — three families for
            // the App Work's fork readiness, Actions hygiene and upstream sync.
            // The dotted CONTRACTS §6 event (`app.fork.ready`, `app.fork.timeout`,
            // `app.fork.missing`, `app.actions.disabled`, `app.upstream.synced`,
            // `app.upstream.behind`, `app.upstream.conflict`,
            // `app.upstream.unavailable`) is stored in `action`.
            ['APP_FORK', 'app_fork'],
            ['APP_ACTIONS', 'app_actions'],
            ['APP_UPSTREAM', 'app_upstream'],
            // APW-03 App spec (T12, Resolution R-2) — the App spec family. The
            // dotted CONTRACTS §6 events (`app.spec.validated`,
            // `app.spec.invalid`, `app.spec.applied`) are stored in `action`.
            ['APP_SPEC', 'app_spec'],
            // APW-05 Builds (T17, Resolution R-2) — the `app_build` family. The
            // dotted CONTRACTS §6 events (`app.build.queued`,
            // `app.build.started`, `app.build.succeeded`, `app.build.failed`,
            // `app.build.cancelled`) are stored in `action`; `blocked` is a
            // stored status and publishes nothing (plan.md:1560).
            ['APP_BUILD', 'app_build'],
        ];

        it.each(cases)('%s → %s', (key, value) => {
            expect(ActivityActionType[key]).toBe(value);
        });

        it('has the expected total number of literal values (catch silent additions)', () => {
            // 103 documented literals — pinned so any silent addition is a
            // deliberate change. Last bumped by the Schedules feature (added
            // MISSION_TICK + IDEA_GENERATED so scheduled Mission ticks and
            // generated Ideas emit Activity, on top of the EW-642 D7 baseline
            // of 101).
            // Previously bumped by EW-642 D7 (added
            // KB_REEMBED_STARTED, KB_REEMBED_COMPLETED, KB_REEMBED_FAILED
            // for the `kb-reembed-work` Trigger.dev task lifecycle, on
            // top of the EW-643 Phase 3 slice 4 baseline of 98).
            // Previously bumped by EW-643 Phase 3 slice 4 (98 — added
            // KB_UPLOAD_RECONCILED + KB_WIKILINK_REWRITTEN for the daily
            // reconciliation task and the wikilink rename rewriter, on
            // top of the 3 EW-693 Phase 10 dynamic-plugin install
            // lifecycle values: PLUGIN_INSTALLED, PLUGIN_INSTALL_FAILED,
            // PLUGIN_UNINSTALLED, which had taken the count to 97 on
            // develop).
            // Previously bumped by EW-643 Phase 3 slice 1 (94 — 10 KB
            // lock/reconcile/transcribe lifecycle values:
            // KB_DOCUMENT_LOCKED, KB_DOCUMENT_UNLOCKED, KB_DOCUMENT_RESTORED,
            // KB_DOCUMENT_LOCK_VIOLATION, KB_RECONCILE_COMPLETED,
            // KB_UPLOAD_TOMBSTONED, KB_UPLOAD_REVIVED, KB_CONTEXT_TRUNCATED,
            // KB_UPLOAD_TRANSCRIBED, KB_UPLOAD_TRANSCRIPTION_FAILED).
            // Previously bumped by post-PR-1019 follow-up FU-2 (84).
            // Domain-model evolution (2026-07): +mission_*/idea_* (PR-3) and
            // +goal_* (PR-8) lifecycle action types took the count 101 -> 114.
            // The Schedules feature then added MISSION_TICK (idea_generated was
            // already added by the domain-model train, so it is shared) -> 115.
            const literals = Object.values(ActivityActionType).filter((v) => typeof v === 'string');
            // +1 EXTERNAL_EVENT_INGESTED (event-ingest spine, Wave 6) -> 116.
            // +2 task_merged / task_merge_refused (agent-merge path, #1874) -> 118.
            // +3 git_pushed / git_committed / git_merged (git activity
            //    ingestion, audit item j) -> 121.
            // +1 idea_deleted (Idea delete, #1997) -> 122.
            // +1 agent_unarchived (Agent archive/restore, #1994) -> 123.
            // +2 inbox_item_created / inbox_item_answered (Inbox operator
            //    message center) -> 125.
            // +3 memory_folder_created / _deleted / _synced (Memory Files —
            //    the /memory Files area folder tree) -> 128 after the
            //    Inbox and Memory Files trains merged together.
            // +3 agent_collaborator_enabled / _disabled / _removed
            //    (Agent Collaborators allow-list edits) -> 131 after the
            //    Inbox train merged develop's Agent Collaborators work.
            // +11 goal_* (Goals autonomy layer: loop lifecycle x5, iteration
            //     dispatch/nudge, limit trip, DoD update, archive/unarchive) -> 142.
            // +6 repo_connection_created / _updated / _deleted / _imported and
            //    repo_attached_to_agent / repo_detached_from_agent
            //    (repository registry, Feature G) -> 148.
            // +5 mcp_connection_created / _updated / _deleted / _tested and
            //    mcp_binding_updated (agent-plugins MCP slice) -> 153.
            // +4 environment_created / _updated / _published / _deleted
            //    (Settings → Environments, via the Agent Workbench branch) -> 157.
            //    `memory_folder_*` arrived on BOTH routes — #2081 straight to
            //    develop and this branch — so it is shared, not additive.
            // +2 schedule_paused / schedule_resumed (Schedules workspace
            //    pause that keeps the cadence) -> 159.
            //
            // +3 agent_run_started / agent_run_completed / agent_run_failed
            //    (Live Feed — run lifecycle for non-heartbeat triggers) -> 160
            //    on develop, which did not yet carry schedule_paused /
            //    schedule_resumed.
            // +1 agent_computer_controlled (Agent computers, take-over) -> 161
            //    on develop, on the same Live-Feed-only base.
            // Merge of develop's Live Feed + Agent computers members with this
            // branch's Schedules workspace pause/resume members:
            // 157 base + 2 + 3 + 1 -> 163.
            //
            // +5 kb_document_archived / _unarchived / _filed / _exported and
            //    memory_folder_renamed (Knowledge library shelf) -> 162 on
            //    develop, on its own Live-Feed base.
            //
            // develop's own ledger for the Skills shelf stretch, kept so
            // neither side's bookkeeping is lost:
            //   +2 skill_enabled / skill_disabled (Skills shelf on/off
            //   switch) -> 159 on develop's own base.
            //   +5 kb_document_archived / _unarchived / _filed / _exported and
            //   memory_folder_renamed (Knowledge library shelf) -> 162 on
            //   develop's own base.
            //
            // 🛑 175 is COUNTED from the merged enum, never added up from the
            // comments above. Every feature branch budgets from its own base
            // (this one said 159, develop was at 160), so after a merge neither
            // side's number is reliable and the arithmetic silently drifts.
            // Scope the count to ActivityActionType — the file also declares
            // ActivityStatus, and including it inflates the total by 5.
            // +11 memory_fact_* x6, memory_facts_cleared, context_file_* x3,
            //     context_budget_exceeded (AW-07 memory facts + context
            //     files) -> 168, counted from the merged enum.
            //
            // +8 model_account_added / _updated / _reordered / _paused /
            //    _resumed / _reconnected / _removed and model_policy_updated
            //    (model accounts, AW-16) -> 165 on this branch's base.
            // +3 agent_run_started / agent_run_completed / agent_run_failed
            //    (Live Feed — run lifecycle for non-heartbeat triggers) -> 160.
            //    On the Knowledge library shelf side the same three literals
            //    land together with its +5 shelf literals: 162 (shelf side) and
            //    160 (develop side) each counted from their own base, and that
            //    merged enum COUNTED 165.
            // +1 agent_computer_controlled (Agent computers, take-over) -> 161
            //    on develop, and -> 166 once the knowledge library branch had
            //    merged develop's Agent computers take-over work.
            //
            // 172 after the AW-07 memory facts + context files branch merged
            // develop again — COUNTED from the merged enum. The AW-07 branch
            // stood at 171 (it had already absorbed develop's Live Feed
            // run-lifecycle members) and develop stood at 161; the only member
            // develop contributed that AW-07 did not already carry is
            // agent_computer_controlled, so 171 + 1 = 172. Do NOT re-derive
            // this by adding the deltas above — count the merged enum.
            //
            // 177 after this branch merged develop's knowledge library shelf
            // (kb_document_archived / _unarchived / _filed / _exported and
            // memory_folder_renamed — the 5 members develop carried that AW-07
            // did not). COUNTED from the merged enum, not added up: this branch
            // stood at 172 and develop at 166, and the overlap between the two
            // is everything except those 5 shelf literals. Recount the enum
            // after every merge instead of trusting either side's number.
            //
            // +5 shared_view_enabled / _disabled / _regenerated /
            //    _sections_changed / _indexing_changed (Shared view, AW-18) —
            //    develop grew these while this branch sat, and they are the only
            //    members develop carried that AW-07 did not already have.
            //
            // 182 after this branch merged develop again. COUNTED from the
            // merged enum, never added up: this branch stood at 177 and develop
            // at 171, the five shared-view literals are everything develop had
            // that this branch lacked, and the eleven memory-fact / context-file
            // literals are everything this branch had that develop lacked.
            // Recount the enum after every merge instead of trusting either
            // side's number.
            //
            // develop's own ledger for the same stretch, kept so neither side's
            // bookkeeping is lost. Its "+3 agent_run_*" line above continues:
            //    (Live Feed — run lifecycle for non-heartbeat triggers) -> 160
            //    on develop's base.
            // +1 agent_computer_controlled (Agent computers, take-over) -> 161
            //    on develop's base.
            // 169 after the model-accounts branch merged develop's Live Feed
            //    and Agent-computers work — COUNTED from the merged enum
            //    (160 shared base + 8 model_* from this branch + 3
            //    agent_run_* + 1 agent_computer_controlled from develop), not
            //    taken from either side's total.
            //
            // develop's own ledger for the same stretch, kept so neither side's
            // bookkeeping is lost. Its "+3 agent_run_*" line above continues:
            //    on this branch's own base; the same +3 reached develop together
            //    with the +5 knowledge library literals, which develop counted
            //    as -> 165 there.
            //
            // Merging develop's Live Feed run lifecycle (+3, develop said 160)
            // into the Skills shelf branch (+2 skill_enabled / skill_disabled,
            // this branch said 159) -> 162, COUNTED from the merged enum.
            // +1 agent_computer_controlled (Agent computers, take-over) —
            //    develop said 161 on its own base; merged with the Skills
            //    shelf branch's 162 this COUNTS to 163 from the merged enum,
            //    not from adding either side's number.
            // Merging develop again (it had reached 166 by landing the
            // Knowledge library shelf's +5 kb_document_archived /
            // _unarchived / _filed / _exported / memory_folder_renamed)
            // into this branch's 163 COUNTS to 168 from the merged enum —
            // the two skill_* literals are this branch's only additions that
            // develop does not already carry.
            //
            // develop's own ledger for the same stretch, kept so neither
            // side's bookkeeping is lost:
            //   +3 agent_run_* (Live Feed — run lifecycle for non-heartbeat
            //   triggers) and +5 knowledge library literals -> 165. Both land
            //   together when the Knowledge library shelf merges develop's
            //   Live Feed work: 162 (shelf side) and 160 (develop side) each
            //   counted from their own base, and the merged enum COUNTS 165.
            //   +1 agent_computer_controlled (Agent computers, take-over)
            //   -> 166 after the knowledge library branch merged develop's
            //   Agent computers take-over work.
            // +5 shared_view_enabled / _disabled / _regenerated /
            //    _sections_changed / _indexing_changed (Shared view, AW-18) — this
            //    branch's own additions, disjoint from everything develop grew
            //    while it was open -> 171 COUNTED from the merged enum (this
            //    branch budgeted 166, develop was at 166, and the five shared-view
            //    literals are the only ones develop does not already have).
            // +2 schedule_paused / schedule_resumed (Schedules workspace pause
            //    that keeps the cadence) — this branch's own additions, the only
            //    two literals develop does not already have -> 173 COUNTED from
            //    the merged enum (this branch budgeted 163, develop was at 171).
            //
            // develop's own ledger for the shared-view stretch, kept so neither
            // side's bookkeeping is lost:
            //   the five shared_view_* literals landed on develop while the
            //   Skills shelf branch was open and counted 171 there; merging that
            //   develop into the shelf branch's 168 COUNTED 173, the two skill_*
            //   literals being that branch's only additions develop lacked.
            //
            // Merging that develop (173, Skills shelf included) into this
            // branch (173, Schedules workspace pause included) COUNTS 175 from
            // the merged enum: schedule_paused / schedule_resumed are the only
            // two literals develop does not carry, and skill_enabled /
            // skill_disabled the only two this branch did not. Neither side's
            // 173 is the answer and the two must never be added together.
            //
            // Merging that develop (175) into this model-accounts branch (169)
            // COUNTS 183 from the merged enum: the eight model_account_* /
            // model_policy_updated literals are the only ones develop does not
            // carry, and the fourteen literals develop grew while this branch
            // was open (skill_*, kb_document_*, memory_folder_renamed,
            // shared_view_*, schedule_*) the only ones this branch lacked.
            // Neither 169 nor 175 is the answer, and 169 + 175 is nonsense —
            // the number below was COUNTED off the merged enum.
            //
            // +3 workspace_backup_created / _downloaded / _deleted (AW-22
            //    Workspace backup) — this branch's own additions, disjoint
            //    from everything develop grew while it was open -> 186
            //    COUNTED from the merged enum. This branch budgeted 164 from
            //    its own base (161 + 3) and develop had reached 183; neither
            //    number is the answer and the two must never be added.
            //
            // develop's own ledger for the same stretch, kept so neither
            // side's bookkeeping is lost:
            //
            // Merging that develop (183, model accounts included) into this
            // AW-07 memory-facts + context-files branch (182) COUNTS 194 from
            // the merged enum: the eleven memory_fact_* / memory_facts_cleared /
            // context_file_* / context_budget_exceeded literals are the only ones
            // develop does not carry, and the twelve literals develop grew while
            // this branch was open (model_account_* x7, model_policy_updated,
            // skill_enabled, skill_disabled, schedule_paused, schedule_resumed)
            // the only ones this branch lacked. Neither 182 nor 183 is the
            // answer, and 182 + 183 is nonsense — 194 was COUNTED off the
            // merged enum, and must be recounted after every merge.
            //
            // This AW-23 branch's own ledger for the same stretch, kept so
            // neither side's bookkeeping is lost:
            //   +5 shared_view_enabled / _disabled / _regenerated /
            //   _sections_changed / _indexing_changed (Shared view, AW-18) —
            //   develop landed those while this branch was open and counted
            //   171 there; merging that develop into the Skills shelf branch's
            //   168 COUNTED to 173 from the merged enum, the two skill_*
            //   literals still being that branch's only additions develop did
            //   not carry.
            //   +3 agent_blocked_on_credential / agent_run_held /
            //   agent_runs_released (the agent brake and the stated halt
            //   reason, AW-23) — this branch's only additions, disjoint from
            //   everything develop grew while it was open -> 176 COUNTED from
            //   the merged enum, not added up from the ledger above.
            //
            // Merging that develop (194, AW-07 memory facts + context files
            // included) into this AW-23 branch (176) COUNTS 197 from the merged
            // enum: agent_blocked_on_credential / agent_run_held /
            // agent_runs_released are the only three literals develop does not
            // carry, and the twenty-one literals develop grew while this branch
            // was open (memory_fact_* x6, memory_facts_cleared, context_file_*
            // x3, context_budget_exceeded, model_account_* x7,
            // model_policy_updated, schedule_paused, schedule_resumed) the only
            // ones this branch lacked. Neither 176 nor 194 is the answer, and
            // 176 + 194 is nonsense — 197 was COUNTED off the merged enum, and
            // must be recounted after every merge.
            //
            // Merging that develop (197, AW-07 memory facts + context files and
            // the AW-23 agent brake included) into this AW-22 Workspace-backup
            // branch (186) COUNTS 200 from the merged enum: the three
            // workspace_backup_created / _downloaded / _deleted literals are the
            // only ones develop does not carry, and the fourteen literals
            // develop grew while this branch was open (memory_fact_* x6,
            // memory_facts_cleared, context_file_* x3, context_budget_exceeded,
            // agent_blocked_on_credential, agent_run_held, agent_runs_released)
            // the only ones this branch lacked. Neither 186 nor 197 is the
            // answer, and 186 + 197 is nonsense — 200 was COUNTED off the merged
            // enum, and must be recounted after every merge.
            //
            // +1 app_launcher (APW-11 App Launcher, T7 — the Work-level
            //    **Show in App Launcher** setting changed) — this branch's own
            //    addition, disjoint from everything the branches above carry,
            //    and counted from the merged enum the same way -> 201. Its
            //    `FEED_KIND_RULES` entry lands in the same change
            //    (`activity-log/feed-kind.ts`, program contract R-34), and its
            //    Shared-view classification needs no edit because
            //    `NEVER_PUBLISH_ACTIVITY_ACTIONS` is the derived complement of
            //    the publishable allow-list.
            //
            // +3 app_fork / app_actions / app_upstream (APW-02 Fork lifecycle,
            //    T15 — Resolution R-2: fork readiness, Actions hygiene and
            //    upstream sync, with the dotted CONTRACTS §6 event in `action`)
            //    — this branch's own additions, disjoint from everything the
            //    branches above carry, and COUNTED from the merged enum the
            //    same way -> 204. Each one carries its `FEED_KIND_RULES` row in
            //    `activity-log/feed-kind.ts` in the same change (program
            //    contract R-34; `feed-kind.spec.ts:14-19` fails on a member
            //    without one), and the Shared-view classification needs no edit
            //    for the same derived-complement reason as `app_launcher`
            //    above. The count moves by exactly the three members this task
            //    appends: no existing pair is renamed, retyped or removed.
            //
            // +1 app_spec (APW-03 App spec, T12 — Resolution R-2's first family:
            //    the App spec read true, with the dotted CONTRACTS §6 event in
            //    `action`) — this branch's own addition, disjoint from everything
            //    the branches above carry, and COUNTED from the merged enum the
            //    same way -> 205. It carries its `FEED_KIND_RULES` row in
            //    `activity-log/feed-kind.ts` in the same change (program contract
            //    R-34; `feed-kind.spec.ts:14-19` fails on a member without one),
            //    and the Shared-view classification needs no edit for the same
            //    derived-complement reason as `app_launcher` above. T12 appends
            //    THIS member and no other: APW-03 T2 owns `app_blueprint` and
            //    `app_license` and has not landed, so when it does it appends its
            //    two and counts 207 — never this one again.
            //
            // +1 app_build (APW-05 Builds, T17 — Resolution R-2's `app_build`
            //    family: one Activity row per `app.build.*` transition, written by
            //    the ONE writer `AppBuildsService.publish`) — this branch's own
            //    addition, disjoint from everything the branches above carry, and
            //    COUNTED from the merged enum the same way -> 206. It carries its
            //    `FEED_KIND_RULES` row in `activity-log/feed-kind.ts` in the same
            //    change (program contract R-34; `feed-kind.spec.ts:14-19` fails on
            //    a member without one), and the Shared-view classification needs no
            //    edit for the same derived-complement reason as `app_launcher`
            //    above. The count moves by exactly the one member this task
            //    appends: no existing member is renamed, retyped or removed.
            expect(literals).toHaveLength(206);
        });

        it('every literal fits the varchar(50) action_type column', () => {
            const literals = Object.values(ActivityActionType).filter(
                (v) => typeof v === 'string',
            ) as string[];
            for (const v of literals) {
                expect(v.length).toBeLessThanOrEqual(50);
            }
        });

        it('every literal value is unique (no accidental duplicate string)', () => {
            const literals = Object.values(ActivityActionType).filter((v) => typeof v === 'string');
            const seen = new Set(literals);
            expect(seen.size).toBe(literals.length);
        });

        it('every literal is lowercase snake_case (no UPPER or kebab)', () => {
            const literals = Object.values(ActivityActionType).filter(
                (v) => typeof v === 'string',
            ) as string[];
            for (const v of literals) {
                expect(v).toMatch(/^[a-z][a-z0-9_]*$/);
            }
        });
    });

    /**
     * Resolution R-2 has two halves: the snake_case family is the
     * `actionType` (pinned above) and the dotted CONTRACTS §6 event is the
     * `action`. APW-02's three families own exactly the eight events below —
     * the six CONTRACTS §6 already listed plus the two APW-02 added
     * (`app.fork.missing`, `app.upstream.unavailable`). A seventh event is
     * added to CONTRACTS §6 and to this list together, never to one alone, so
     * a family cannot quietly start writing an event nobody specified.
     */
    describe('APW-02 App Works families — the dotted `action` each one carries', () => {
        const FAMILIES: Array<{
            actionType: ActivityActionType;
            namespace: string;
            events: readonly string[];
        }> = [
            {
                actionType: ActivityActionType.APP_FORK,
                namespace: 'app.fork',
                events: ['app.fork.ready', 'app.fork.timeout', 'app.fork.missing'],
            },
            {
                actionType: ActivityActionType.APP_ACTIONS,
                namespace: 'app.actions',
                events: ['app.actions.disabled'],
            },
            {
                actionType: ActivityActionType.APP_UPSTREAM,
                namespace: 'app.upstream',
                events: [
                    'app.upstream.synced',
                    'app.upstream.behind',
                    'app.upstream.conflict',
                    'app.upstream.unavailable',
                ],
            },
        ];

        it.each(FAMILIES)(
            '$actionType writes $namespace.* events, and only those',
            ({ actionType, namespace, events }) => {
                // The family and its namespace are the same word — snake_case in
                // `actionType`, dotted in `action` (R-2).
                expect(actionType).toBe(namespace.split('.').join('_'));
                for (const event of events) {
                    expect(event.startsWith(`${namespace}.`)).toBe(true);
                    expect(event).toMatch(/^app(\.[a-z][a-z0-9_]*)+$/);
                }
            },
        );

        it('pins the whole APW-02 event set — six from CONTRACTS §6 plus the two APW-02 adds', () => {
            expect(FAMILIES.flatMap((family) => [...family.events])).toEqual([
                'app.fork.ready',
                'app.fork.timeout',
                'app.fork.missing',
                'app.actions.disabled',
                'app.upstream.synced',
                'app.upstream.behind',
                'app.upstream.conflict',
                'app.upstream.unavailable',
            ]);
        });
    });

    describe('ActivityStatus — pinned literal values', () => {
        const cases: Array<[keyof typeof ActivityStatus, string]> = [
            ['PENDING', 'pending'],
            ['IN_PROGRESS', 'in_progress'],
            ['COMPLETED', 'completed'],
            ['FAILED', 'failed'],
            ['CANCELLED', 'cancelled'],
        ];

        it.each(cases)('%s → %s', (key, value) => {
            expect(ActivityStatus[key]).toBe(value);
        });

        it('has exactly 5 documented literal values', () => {
            const literals = Object.values(ActivityStatus).filter((v) => typeof v === 'string');
            expect(literals).toHaveLength(5);
        });

        it('every literal value is unique', () => {
            const literals = Object.values(ActivityStatus).filter((v) => typeof v === 'string');
            expect(new Set(literals).size).toBe(literals.length);
        });
    });

    describe('CreateActivityLogDto — accepts every documented field shape', () => {
        it('accepts a minimal DTO with only the required fields', () => {
            const dto: CreateActivityLogDto = {
                userId: 'u1',
                actionType: ActivityActionType.WORK_CREATED,
                action: 'work.created',
                status: ActivityStatus.COMPLETED,
                summary: 'Work created',
            };
            expect(dto.userId).toBe('u1');
            expect(dto.actionType).toBe('work_created');
            expect(dto.summary).toBe('Work created');
        });

        it('accepts every optional field', () => {
            const dto: CreateActivityLogDto = {
                userId: 'u1',
                workId: 'w1',
                actionType: ActivityActionType.GENERATION,
                action: 'work.generation_started',
                status: ActivityStatus.IN_PROGRESS,
                summary: 'Generation started',
                details: { provider: 'openai' },
                metadata: { duration: 1234 },
                ipAddress: '192.0.2.1',
                userAgent: 'Mozilla/5.0',
            };
            expect(dto.workId).toBe('w1');
            expect(dto.details).toEqual({ provider: 'openai' });
            expect(dto.metadata).toEqual({ duration: 1234 });
            expect(dto.ipAddress).toBe('192.0.2.1');
            expect(dto.userAgent).toBe('Mozilla/5.0');
        });

        it('actionType is constrained to the enum (validated at compile time)', () => {
            // This test exists to ensure the type union is connected to the
            // enum — a runtime check that the dto's actionType field is set
            // to a known enum value.
            const dto: CreateActivityLogDto = {
                userId: 'u',
                actionType: ActivityActionType.SCHEDULE_EXECUTED,
                action: 'work.schedule.executed',
                status: ActivityStatus.COMPLETED,
                summary: '',
            };
            expect(Object.values(ActivityActionType)).toContain(dto.actionType);
        });
    });

    describe('ActivityLogQueryOptions — accepts every documented field shape', () => {
        it('accepts a minimal query with only userId', () => {
            const opts: ActivityLogQueryOptions = { userId: 'u1' };
            expect(opts.userId).toBe('u1');
        });

        it('accepts every optional filter', () => {
            const dateFrom = new Date('2026-05-01T00:00:00Z');
            const dateTo = new Date('2026-05-31T23:59:59Z');
            const opts: ActivityLogQueryOptions = {
                userId: 'u1',
                actionType: ActivityActionType.ITEM_ADDED,
                workId: 'w1',
                status: ActivityStatus.COMPLETED,
                dateFrom,
                dateTo,
                search: 'foo',
                limit: 100,
                offset: 50,
            };
            expect(opts.actionType).toBe('item_added');
            expect(opts.dateFrom).toBe(dateFrom);
            expect(opts.dateTo).toBe(dateTo);
            expect(opts.search).toBe('foo');
            expect(opts.limit).toBe(100);
            expect(opts.offset).toBe(50);
        });
    });
});
