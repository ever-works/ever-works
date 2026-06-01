export const meta = {
    name: 'ever-works-e2e-1000-build-wave',
    description: 'Build a wave of complex e2e flow files — each agent surveys coverage for its theme then implements ~6 uncovered complex flows',
    phases: [{ title: 'Build wave', detail: 'one agent per themed flow file' }],
};

// All ~168 themed files (24 domains x 7). A wave selects a slice via
// args = { start, count }. Re-invoke with different args per wave.
const THEMES = [
    // ── auth & sessions ─────────────────────────────────────────────
    ['flow-session-multi-device-revocation.spec.ts', 'multi-session/multi-device inventory + targeted/all-other/idempotent revocation propagation across independent cookie-jar contexts (GET /api/auth/session, session list, revoke-by-id, revoke-others); logout is single-session not global'],
    ['flow-refresh-token-rotation.spec.ts', 'JWT access+refresh rotation, old-token reuse detection/family-burn, expired-access-recovered-via-refresh, refresh-after-logout rejected, malformed/cross-user refresh rejected, concurrent refresh race'],
    ['flow-2fa-state-machine.spec.ts', '2FA full state machine: enroll→verify→challenge-on-login→backup-code recovery→disable; step-up on sensitive op; wrong code lockout; recovery-code single-use (degrade .or()/skip if 2FA endpoints absent)'],
    ['flow-api-key-scope-enforcement.spec.ts', 'api-key SCOPE/permission ENFORCEMENT matrix (not lifecycle): a scoped key can hit allowed endpoints and is 403 on out-of-scope ones; expired/revoked key 401; key cannot escalate beyond owner; x-api-key vs bearer precedence'],
    ['flow-auth-method-precedence.spec.ts', 'auth-method precedence/conflict: bearer + api-key both present, cookie + bearer mismatch, anonymous→authenticated upgrade, conflicting identities resolve to one deterministic principal; 401 shapes uniform'],
    ['flow-session-idle-absolute-expiry.spec.ts', 'idle vs absolute session expiry, sliding renewal on activity, cookie rotation on privilege change, concurrent-tab session consistency'],
    ['flow-account-lockout-recovery.spec.ts', 'failed-login lockout threshold + lockedUntil, recovery after window, lock does not leak existence, reset-password clears lock, lock is per-account not per-IP (probe real thresholds)'],
    // ── mail flows ──────────────────────────────────────────────────
    ['flow-magic-link-deep.spec.ts', 'magic-link deep: issue→redeem→session, redeem-twice rejected, expired token, cross-account token, providers advertise magic-link; mail-content BEST-EFFORT (SMTP PLAIN fails)'],
    ['flow-password-reset-deep.spec.ts', 'password-reset deep edges: token single-use, invalid/expired token exact message, policy enforcement on new password, reset signs out other sessions, uniform unknown-email response'],
    ['flow-email-verification-deep.spec.ts', 'email-verification: register token-usable-immediately (REQUIRE_EMAIL_VERIFICATION=false), resend auth-gated/idempotent, verify rejects bad token, verified transition single-use (mail best-effort)'],
    ['flow-email-change-flow.spec.ts', 'change email: request→confirm via token, old email retains until confirm, duplicate-email rejected, pending-change cancel, login still works during pending (probe; degrade if absent)'],
    ['flow-invitation-email-roundtrip.spec.ts', 'work/org invitation email round-trip: issue invite→(mail best-effort)→accept via token→membership; resend; revoke pending; expired invite'],
    ['flow-mail-deeplink-bounce.spec.ts', 'email deeplink resolution (verify/reset/invite links land on correct page with token prefilled), bounce handling contract, link host allow-list / open-redirect prevention on email links'],
    ['flow-notification-email-channel.spec.ts', 'notification email channel: enable email channel, trigger an email-bearing event, mailbox best-effort assert, preference gates email vs in-app, digest/batching contract if present'],
    // ── orgs & tenants ──────────────────────────────────────────────
    ['flow-org-switch-context-propagation.spec.ts', 'switch active org → subsequent scoped reads reflect the org (header/cookie/URL slug), resources created under org A invisible under org B, switch-back restores; lastScopeOrganizationId persistence'],
    ['flow-org-member-roles-matrix.spec.ts', 'org member role matrix: owner/admin/member capabilities (invite, remove, rename org, manage members), role downgrade/upgrade, last-owner cannot be removed, non-member 403'],
    ['flow-org-slug-lifecycle.spec.ts', 'org slug allocation/collision/suggestion (-2,-3), check-slug availability (value= param), rename slug uniqueness, reserved slugs, global slug resolver semantics'],
    ['flow-org-upgrade-from-account.spec.ts', 'upgrade-from-account: personal→org migration of existing entities (degrade on sqlite-only Postgres paths), register-company flow, lazy-tenant minting + tenantId backfill consistency across resource types'],
    ['flow-tenant-isolation-resources.spec.ts', 'tenant isolation across EVERY resource type (works/agents/tasks/missions/skills/conversations/kb): two tenants see only own rows on every list; cross-tenant GET/PATCH/DELETE forbidden'],
    ['flow-org-billing-scope.spec.ts', 'org-scoped subscription/plan/usage vs personal scope, budget caps at org level, member usage attribution, org plan transition (probe; degrade if billing scope absent)'],
    ['flow-org-settings-persistence.spec.ts', 'org settings/profile (displayName/legalName/countryCode/registrationStatus) update + persistence + validation, org avatar/branding, settings visible to members per role'],
    // ── works core ──────────────────────────────────────────────────
    ['flow-work-items-crud-deep.spec.ts', 'work items sub-resource deep: list contract, submit-item DTO validation (name/source_url/category/categories), git-gated write (400 reconnect-git), pagination/filter, item count reflection'],
    ['flow-work-taxonomy-deep.spec.ts', 'categories/tags/collections: read contract, git-gated writes (500), categories-tags shape, collection membership, count endpoint accuracy, taxonomy isolation per work'],
    ['flow-work-config-cache.spec.ts', 'work config get/set, configCache lifecycle, readmeConfig, kbConfig, comparison/community-PR/source-validation flags persistence + interaction'],
    ['flow-work-delete-cascade.spec.ts', 'work hard-delete cascade (items/taxonomy/kb/budgets/activity gone), delete is owner-gated (403 non-owner), delete returns deleted_repositories, double-delete 404, delete during generation'],
    ['flow-work-stats-aggregation.spec.ts', 'GET /api/works/stats aggregation accuracy across multiple works (totalWorks/Items/activeWebsites/generatingCount/totalMissions/totalIdeas), per-work count vs global stats consistency, stats are user-scoped'],
    ['flow-work-rename-slug-collision.spec.ts', 'work rename + slug regeneration, slug collision handling, name length/char edge cases, description update propagation to list + detail UI, optimistic concurrency on rapid updates'],
    ['flow-work-kind-variants.spec.ts', 'work kind variants (default/company/etc), domainType inference + manual override, work creation with organization:true vs false, repoVisibility, storage/git/deploy provider defaults'],
    // ── works generation & pipeline ─────────────────────────────────
    ['flow-work-generation-lifecycle.spec.ts', 'trigger work generation → generateStatus/generationStartedAt/ProgressedAt lifecycle (Trigger-gated: assert records not completion), generation isolation per work, re-generate, generation on deleted work'],
    ['flow-work-generation-cancel.spec.ts', 'cancel an in-flight generation, cancellation state transition, cancel when not generating (no-op/400), cancel-then-regenerate, concurrent cancel race'],
    ['flow-work-scheduled-updates.spec.ts', 'scheduled updates: enable + cadence + scheduledNextRunAt computation, disable, manual trigger, scheduledStatus transitions, schedule interaction with generation'],
    ['flow-work-community-pr.spec.ts', 'community-PR: enable/auto-close flags, PR state transitions, lastPullRequest tracking, community-PR disabled blocks, interaction with git-provider connection (degrade if git not connected)'],
    ['flow-work-source-validation.spec.ts', 'source validation enable + cadence + nextRun/lastRun, sourceValidationEnabled gating, validation status, interaction with items/import'],
    ['flow-work-pipeline-plugin-binding.spec.ts', 'pipeline plugin selection per work (standard/agent/etc), active pipeline capability, pipeline config, switching pipeline plugin, work inherits user-default pipeline'],
    ['flow-work-deploy-state.spec.ts', 'work deploy state machine (deploymentState/StartedAt/lastDeployCorrelationId), deploy capability gating (configured-vs-unconfigured), deployProjectId, redeploy, deploy on undeployable work'],
    // ── works sync / import-export ──────────────────────────────────
    ['flow-work-import-deep.spec.ts', 'import work from payload/source deep: items/taxonomy land, malformed payload rejected, import idempotency / re-import behaviour, import into existing work, large-import pagination'],
    ['flow-work-export-roundtrip.spec.ts', 'export work (format/contract) → re-import → integrity round-trip, export excludes secrets, export of empty work, export reflects updates'],
    ['flow-data-sync-dispatch-deep.spec.ts', 'data-sync dispatch tick shape {due,dispatched,skipped,failed}, retry-backoff suppression (skip on enqueued/git-connected), idempotency key duplicate suppression, dispatch on deleted work'],
    ['flow-platform-sync-secret.spec.ts', 'platform-sync secret rotate (PLATFORM_API_SECRET_TOKEN-gated, read from env), rotate→old secret invalid, encrypted-at-rest contract, rotate idempotency/409, secret never returned in GET'],
    ['flow-activity-sync-modes.spec.ts', 'activity-sync pull vs push mode, mode switch, platformSyncLastSuccess/Error tracking, ingest with platform secret (401 without), webhook secret rotation'],
    ['flow-work-webhook-signatures.spec.ts', 'github-app/work webhook signature verify (valid HMAC accepted, tampered rejected), webhook secret rotation invalidates old, replay/timestamp window, unknown event handling'],
    ['flow-work-sync-conflict.spec.ts', 'sync conflict / lastSyncedDataRepoSha mismatch, pendingSyncRequestedAt, syncIntervalMinutes, concurrent sync dispatch dedup, sync during generation'],
    // ── works collab / claim ────────────────────────────────────────
    ['flow-work-invite-accept-rbac.spec.ts', 'work invite→accept→role-scoped access (viewer/editor/manager capabilities matrix on GET/PATCH/items), non-member 403, owner in separate field not members[]'],
    ['flow-work-member-removal.spec.ts', 'work member removal revokes access (poll to 403), removed from members list, ex-member 403/404 on members, double-remove 404, owner cannot remove self / be removed'],
    ['flow-work-invitation-tokens.spec.ts', 'invitation token single-use (replay 400 already-accepted), unknown token 404, preview before accept, expired invite, role baked into token honored on accept'],
    ['flow-claim-zero-friction-deep.spec.ts', 'zero-friction anonymous work creation → claimable state → claim by token binds to identity, invalid/used claim token rejected, identity-mismatch rejected, anon expiry'],
    ['flow-work-transfer-ownership.spec.ts', 'work ownership transfer flow (transferStatus), accept transfer, decline, transfer to non-member auto-adds, original owner loses owner rights (probe; degrade if absent)'],
    ['flow-work-sharing-visibility.spec.ts', 'work sharing/visibility: private vs shared, shared-with-me listing (isShared), public contract (none for per-work read → 401 anon), share link semantics'],
    ['flow-work-collab-concurrent-edit.spec.ts', 'two members edit the same work concurrently, last-write/optimistic conflict, activity feed records both actors, member sees other member changes on refresh'],
    // ── agents ──────────────────────────────────────────────────────
    ['flow-agent-permissions-matrix.spec.ts', 'agent 8-permission matrix: each capability flag default-false; flipping canAssignTasks/canSpend/canCommitToRepo/canCallExternalTools/canEditAgentFiles/canCreateAgents gates the corresponding op (probe enforcement)'],
    ['flow-agent-instruction-files-deep.spec.ts', 'all 5 canonical files (SOUL/AGENTS/HEARTBEAT/TOOLS/agent.yml) PUT/GET, independent 64-hex hashes, stale-hash conflict rejection, UI editor round-trip (controlled-textarea native-setter), empty-file defaults'],
    ['flow-agent-budget-enforcement.spec.ts', 'agent budget: currentSpendCents/capCents/period/currency shape, set cap, over-budget contract, budget reset on period, budget vs canSpend permission interaction, budget isolation per agent'],
    ['flow-agent-runs-pagination.spec.ts', 'agent runs history: accumulate run records via assign-task (enqueue 500 but record persists), pagination meta newest-first no-overlap, filter by task, run status/triggerKind/durationMs shape'],
    ['flow-agent-scoping-matrix-deep.spec.ts', 'agents scoped tenant/mission/idea/work: each requires parent id (400 without), scope filter returns only that scope, cross-scope isolation, parent-deletion effect on scoped agent'],
    ['flow-agent-templates-clone.spec.ts', 'agent template catalog, create-from-template, clone an agent (copies files/permissions/budget? probe), template avatar (avatarImageUploadId), template isolation'],
    ['flow-agent-inbox-messaging.spec.ts', 'agent inbox: compose message, thread, read/unread, reply, message ordering, inbox isolation per agent/user (probe endpoints; degrade .or() if absent)'],
    // ── skills ──────────────────────────────────────────────────────
    ['flow-skill-crud-scoping.spec.ts', 'skill CRUD with scope/ownerType/ownerId validation (tenant needs explicit ownerId), skill types, update/delete, cross-user isolation, list filter by ownerType/ownerId'],
    ['flow-skill-agent-binding-deep.spec.ts', 'bind/unbind/rebind skill↔agent, agent lists bound skills, binding priority order resolution, multi-skill bindings, maxSkillContextTokens interaction, bind nonexistent skill 404'],
    ['flow-skill-versioning.spec.ts', 'skill content/version updates, skill body persistence + hash, skill used by multiple agents reflects updates, skill delete with active bindings (cascade/block — probe)'],
    ['flow-skill-marketplace-share.spec.ts', 'skill sharing/visibility/marketplace (public vs private skills), import/copy a shared skill, skill discovery list, share isolation (probe; degrade if absent)'],
    ['flow-skill-binding-permission.spec.ts', 'skill binding gated by agent canEditSkills permission, binding a tenant skill to a work agent scope rules, binding cross-tenant skill forbidden'],
    ['flow-skill-context-assembly.spec.ts', 'skill context assembly into agent (token budget truncation maxSkillContextTokens), ordering, multiple skills combined, context reflects skill updates (probe observable surface)'],
    ['flow-skill-bulk-operations.spec.ts', 'create many skills + filter/search/pagination meta, bulk bind to an agent, list scoping correctness across users, skill name collision handling'],
    // ── tasks ───────────────────────────────────────────────────────
    ['flow-task-full-lattice.spec.ts', 'EXHAUSTIVE task status lattice: every legal transition asserted + side-effects (startedAt/completedAt), every illegal hop 400, force is approver-gate not lattice-bypass, cancelled/blocked terminality'],
    ['flow-task-assignees-deep.spec.ts', 'task assignees user+agent: add (201), duplicate (500 uq_task_assignee), remove, multiple assignees, assignee type validation, agent dispatch creates run record'],
    ['flow-task-approvers-gate.spec.ts', 'requireAllApprovers: add approvers, transition-to-done gated until all approve, force overrides approver gate (not lattice), partial approval, approver removal effect'],
    ['flow-task-hierarchy-deep.spec.ts', 'parent/subtask: create tree, filter by parentTaskId, parent completion rules vs open subtasks, cascade on parent delete/cancel, depth limits, subtask reparent'],
    ['flow-task-labels-priority-search.spec.ts', 'labels add/remove, priority p0-p4 set, filter by label/priority/status combos, full-text search, pagination meta windows (limit/offset/total) exhaustion, sort order'],
    ['flow-task-collaboration.spec.ts', 'task comments/collaboration, mentions, watchers, activity on task, multi-user task interaction, task visibility per work membership'],
    ['flow-task-scope-linkage.spec.ts', 'task linked to mission/idea/work: filter by each, task moves with scope, cross-scope task isolation, orphan task (no scope), task tenant stamping'],
    // ── missions & ideas ────────────────────────────────────────────
    ['flow-mission-crud-schedule.spec.ts', 'mission CRUD, type one-shot vs ongoing, schedule/cadence, autoBuildWorks toggle, status active/paused, schedule→nextRun computation, validation'],
    ['flow-mission-tick-cap.spec.ts', 'mission tick endpoint {action,ideasCreated/Queued} shape, outstandingIdeasCap enforcement, tick respects cap, tick on paused mission, manual vs scheduled tick'],
    ['flow-mission-clone-fork.spec.ts', 'full-fork clone copies metadata+non-dismissed ideas (as pending)+guardrailsOverride+sourceMissionId backlink, works NOT cloned, clone isolation, clone of clone'],
    ['flow-idea-build-lifecycle.spec.ts', 'idea/work-proposal build: create (desc>=10), queue build, status transitions, retry failed, rebuild, per-build budget, build on dismissed idea'],
    ['flow-idea-to-work-accept.spec.ts', 'idea→work accept flow (acceptedFromIdeaId on work), accept creates work with mission linkage, decline/dismiss idea, accept twice, accept after build'],
    ['flow-mission-guardrails.spec.ts', 'mission guardrailsOverride persistence + enforcement, missionTemplateRepo, guardrails inherited by ideas, guardrail violation handling (probe), guardrail edit propagation'],
    ['flow-mission-ideas-isolation.spec.ts', 'ideas filtered by missionId, idea cross-user/cross-tenant isolation, mission list owner-scoped, idea count vs mission, idea ordering/pagination'],
    // ── plugins (AI) ────────────────────────────────────────────────
    ['flow-plugin-ai-provider-resolution.spec.ts', 'AI provider resolution: enable multiple providers, default selection order, X-Provider-Override resolution, per-work provider override, work>user>admin>default precedence (adaptive completions)'],
    ['flow-plugin-ai-settings-validation.spec.ts', 'AI plugin settings schema validation: required fields (openrouter apiKey+defaultModel), secretSettings masking, env-var binding (x-envVar), invalid settings 400 with errors[], resolvedSettings shape'],
    ['flow-plugin-ai-models-catalogue.spec.ts', 'GET /api/plugins/:id/models per AI provider, model selection persistence (defaultModel), model used reflected in completion (adaptive), unknown model handling, models for disabled plugin'],
    ['flow-plugin-system-rules.spec.ts', 'system-plugin rules: openrouter system plugin disable 400 cannot-disable, autoEnable/defaultForCapabilities, system vs user plugin, builtIn flag, visibility public'],
    ['flow-plugin-ai-gateway.spec.ts', 'ai-gateway plugins (openrouter/vercel-ai-gateway) enable + settings + provider override through gateway, gateway vs direct provider precedence, gateway model passthrough (adaptive)'],
    ['flow-plugin-per-work-ai.spec.ts', 'per-work AI plugin enablement, work active capability, autoEnableForWorks, work inherits user AI default, work-level override of user provider, isolation from user-level'],
    ['flow-plugin-ai-byok.spec.ts', 'BYOK: PATCH user AI plugin settings with apiKey (FRESH user — isolation!), key masked in GET, key used for completion (adaptive), invalid key handling, clear/rotate key'],
    // ── plugins (non-AI) ────────────────────────────────────────────
    ['flow-plugin-search-lifecycle.spec.ts', 'search plugin (tavily/brave/etc) enable/disable, settings validation, search capability endpoint (configured-vs-unconfigured contract), default search provider, results contract'],
    ['flow-plugin-content-extractor.spec.ts', 'content-extractor plugins enable/disable, capability endpoint, settings, default extractor (local), extract contract (configured-vs-unconfigured), per-work extractor'],
    ['flow-plugin-screenshot.spec.ts', 'screenshot plugins (screenshotone/urlbox/scrapfly) enable, capability contract configured-vs-unconfigured, settings, screenshot facade truthful contract without external call'],
    ['flow-plugin-git-provider.spec.ts', 'git-provider (github) connection status, connect entry-point, OAuth git connection contract, gated git operations (work creation git-gated), disconnect, default git provider'],
    ['flow-plugin-deployment.spec.ts', 'deployment plugin (vercel) enable, deploy capability configured-vs-unconfigured, deploy facade contract, deployProjectId, per-work deploy provider, default deploy'],
    ['flow-plugin-oauth-deviceauth.spec.ts', 'plugin OAuth connection + device-auth status contracts, connect/disconnect, connection isolation per user, device-auth pending/poll, oauth state integrity'],
    ['flow-plugin-work-level-matrix.spec.ts', 'work-level plugin enablement matrix across categories, active capability per category, work plugin settings vs user plugin settings, enable/disable per work isolation'],
    // ── chat & conversations ────────────────────────────────────────
    ['flow-chat-roundtrip-adaptive.spec.ts', 'chat UI round-trip adaptive: send message → real reply when provider configured else truthful provider-unavailable + composer alive; user msg renders; New chat resets; provider selector states'],
    ['flow-conversation-crud-deep.spec.ts', 'conversation CRUD: create/list/get/rename/delete, messages append (201)/ordering, auto-title from first msg (<=60 verbatim else 57+...), blank-conversation title, 404 on missing'],
    ['flow-chat-work-scoped-deep.spec.ts', 'work-scoped chat (X-Work-Id): conversation↔work linkage, work-context isolation A vs B, provider/model metadata on conversation, work chat history'],
    ['flow-chat-history-ui.spec.ts', 'chat history UI: open panel→History→conversation list, empty-state, reopen conversation with messages intact, delete from history, history ordering (today/yesterday/Nd ago)'],
    ['flow-chat-tools-canvas.spec.ts', 'chat-does-everything (#1200): tool generation/confirmation gate for destructive ops, no-bulk guard, canvas rendering of a tool result; assert the confirmation-gate + no-bulk contract (adaptive on AI)'],
    ['flow-chat-streaming-events.spec.ts', 'chat SSE streaming contract: event shape, stop-generating, partial-then-stall without key (assert plumbing not !ok), reconnect, message persistence after stream'],
    ['flow-chat-provider-switch.spec.ts', 'switch chat provider mid-conversation, provider not-configured state messaging ("Set it up in Plugins"), model switch, conversation records provider/model, switch isolation'],
    // ── KB ──────────────────────────────────────────────────────────
    ['flow-kb-document-lifecycle-deep.spec.ts', 'KB doc lifecycle: upload→tree→fetch body→edit→version/history→delete, supported types, upload size cap (200MiB), kb-fixtures helper, per-work KB isolation'],
    ['flow-kb-inherited-overrides-deep.spec.ts', 'org KB inherited by work, Work override excludes inherited (workId===null filter), partial vs full override, inherited isolation across works, override delete restores inheritance'],
    ['flow-kb-citations.spec.ts', 'KB citations: citation path <class>/<slug> resolves, citation in generated content, broken citation handling, citation across inherited docs'],
    ['flow-kb-search-semantic.spec.ts', 'KB search: keyword + semantic/RRF ranking, embeddings indexing, search scoping per work, search empty/no-results, search reflects new/edited docs'],
    ['flow-kb-viewers-media.spec.ts', 'KB media viewers (pdf/img/csv/xlsx), >5MiB viewer download-fallback, viewer dispatcher by type, unsupported type fallback, viewer size cap'],
    ['flow-kb-wikilinks-mentions.spec.ts', 'KB wikilinks [[doc]] resolution + backlinks, mentions of agents/works, broken wikilink, wikilink editor, mention autocomplete (probe observable)'],
    ['flow-kb-locking-history.spec.ts', 'KB doc locking (edit lock/unlock), concurrent-edit conflict, history/git-log of changes, revert to prior version, autosave'],
    // ── profile & account ───────────────────────────────────────────
    ['flow-profile-identity-deep.spec.ts', 'profile update username/avatar(URL)/committerName/committerEmail/emailBudgetAlerts + fresh-profile reflection + render in chrome, invalid committerEmail/avatar 4xx, allowed avatar hosts'],
    ['flow-account-data-export.spec.ts', 'account data export contract (shape contains user data), export excludes secrets/passwords, export of populated account (works/agents), export auth-gated'],
    ['flow-account-deletion-deep.spec.ts', 'account deletion initiate→confirm/grace contract, deleted/anonymized behaviour, deletion with owned resources (cascade/block), cancel deletion in grace, re-register after deletion'],
    ['flow-account-merge-deep.spec.ts', 'account merge / link providers, merge-conflict resolution, duplicate-email across providers, unlink provider, merge preserves resources (probe; degrade if absent)'],
    ['flow-account-research-optout.spec.ts', 'userResearchOptOut + inferredInterests + suggestedVerticals persistence, opt-out gates telemetry/inference, opt-out reversible, defaults'],
    ['flow-profile-budget-alerts.spec.ts', 'emailBudgetAlerts toggle gates 75/90/100/overage email (in-app always fires), per-threshold notification, alert on agent/work budget, alert preference persistence'],
    ['flow-account-anonymous-upgrade.spec.ts', 'anonymous account → real identity upgrade, anonymousExpiresAt, anon resource ownership transfers on upgrade, anon limits, expired anon cleanup contract'],
    // ── settings & integrations ─────────────────────────────────────
    ['flow-settings-notification-channels.spec.ts', 'notification channels CRUD (in-app/email/webhook?), channel enable/disable, per-channel preferences, channel verification, settings UI columns (In-app etc) + persistence'],
    ['flow-settings-integrations-channels.spec.ts', 'integrations channels (slack/discord/webhook?) connect/configure/test/disconnect, channel message routing, integration isolation per user/work (probe; degrade if absent)'],
    ['flow-settings-work-agent.spec.ts', 'work-agent integration settings, agent-per-work config, work-agent enable + binding, settings persistence + validation'],
    ['flow-settings-git-providers.spec.ts', 'git-provider connections settings UI, connect/disconnect github, connection status display, multiple providers, committer identity from connection'],
    ['flow-settings-github-app.spec.ts', 'github-app installation/webhook settings, app config, installation status, webhook signature settings, app vs oauth distinction'],
    ['flow-settings-security-deep.spec.ts', 'security settings: sessions list/revoke UI, 2FA toggle, password change, api-keys management UI, security event log, danger-zone gating'],
    ['flow-settings-data-privacy.spec.ts', 'data settings: export/import preferences, retention, privacy toggles, device-fingerprinting opt-out, data-sync preferences, danger zone (delete account/data)'],
    // ── notifications ───────────────────────────────────────────────
    ['flow-notifications-read-lifecycle.spec.ts', 'in-app notification create→list→read→unread-count decrement, mark-all-read, bell UI (svg.lucide-bell) + dropdown empty/populated state, notification ordering'],
    ['flow-notifications-preferences.spec.ts', 'notification preferences gate which channels deliver an event (settings UI), per-type prefs, default prefs, preference persistence + effect on production'],
    ['flow-notifications-per-event.spec.ts', 'per-event notification production: agent run, task assigned, budget threshold, invitation, generation done — each produces the right notification (probe which events fire)'],
    ['flow-notifications-bulk.spec.ts', 'notification list pagination, bulk mark-read, delete/dismiss, unread filter, notification retention, high-volume list performance'],
    ['flow-notifications-realtime.spec.ts', 'notification real-time/poll update (new notification appears without full reload), unread badge live update, SSE/poll contract (probe observable)'],
    ['flow-notifications-cross-user.spec.ts', 'notification isolation: user A action does not leak notification to user B, org/work notifications scoped to members, notification actor attribution'],
    ['flow-notifications-digest.spec.ts', 'notification digest/batching, quiet hours, email digest preference, digest content (mail best-effort), digest opt-out (probe; degrade if absent)'],
    // ── activity & audit ────────────────────────────────────────────
    ['flow-activity-feed-perwork-deep.spec.ts', 'per-work activity feed: each mutation records actor+type+timestamp in order, feed pagination, feed scoping per work, feed reflects multi-actor (members)'],
    ['flow-activity-export-sanitization.spec.ts', 'activity export format + sanitization (secrets redacted), export contains recorded entries, export auth-gated, export of empty feed, CSV/JSON shape'],
    ['flow-activity-immutability.spec.ts', 'activity entries immutable (mutate/delete rejected), sequence monotonic/integrity, tamper-resistance (hash chain?), gap detection'],
    ['flow-activity-ingest-platform.spec.ts', 'activity ingest endpoint (platform secret 401 without), ingest validation, ingested entries appear in feed, ingest idempotency, ingest rate-limit'],
    ['flow-activity-audit-account.spec.ts', 'account-level audit log (login/logout/password-change/2fa/api-key events), audit visibility per user, audit retention, audit export'],
    ['flow-activity-org-audit.spec.ts', 'org-level audit (member add/remove/role-change, settings change), audit scoped to org admins, audit actor attribution, cross-org audit isolation'],
    ['flow-activity-sequences-concurrency.spec.ts', 'activity sequence under concurrent mutations (no gaps/dupes), sequence per-scope, high-frequency activity ordering, sequence after restart (probe observable)'],
    // ── subscriptions & budgets ─────────────────────────────────────
    ['flow-subscription-plan-tiers.spec.ts', 'subscription plan/tier shape, free vs paid, tier transition/upgrade, tier feature gating, plan code, plan persistence (SUBSCRIPTIONS_ENABLED=true)'],
    ['flow-subscription-billing-grace.spec.ts', 'billing grace period, past-due state, grace expiry behaviour, dunning, reactivation, grace gating of features (probe)'],
    ['flow-budget-caps-global.spec.ts', 'global budget cap create/list/update/delete (monthlyCapCents/allowOverage/currency), cap enforcement, over-budget contract, cap isolation per scope'],
    ['flow-budget-caps-perwork.spec.ts', 'per-work budget cap create/list, work cap vs global cap precedence, work cap enforcement, cap on deleted work, work budgets-usage page render (adaptive .or() not-found)'],
    ['flow-budget-agent-spend.spec.ts', 'agent budget cap + currentSpendCents tracking, spend accrual (probe observable), over-budget blocks agent op, agent budget vs global, period reset'],
    ['flow-usage-tracking.spec.ts', 'usage tracking endpoints (per-user/per-work/per-agent), usage shape, admin-usage aggregation, usage attribution, usage vs budget reconciliation'],
    ['flow-subscription-admin-usage.spec.ts', 'admin usage dashboard data, cross-user usage (admin-gated 403 for non-admin), usage period filters, usage export, platform-admin gating (isPlatformAdmin)'],
    // ── oauth & deploy capabilities ─────────────────────────────────
    ['flow-oauth-providers-deep.spec.ts', 'GET /api/auth/providers shape per env (github/google/magic-link), authorize redirect issuance, callback state integrity (mismatch rejected), provider isolation (mocked upstream)'],
    ['flow-git-provider-connection.spec.ts', 'git-provider connection status/connect/disconnect, connected-as display, multiple git accounts, connection gates work git-ops, connection isolation per user'],
    ['flow-deploy-capability-contract.spec.ts', 'deploy capability configured-vs-unconfigured contract (no real deploy), deploy facade shape, deploy provider selection, deploy gating, deploy correlation tracking'],
    ['flow-screenshot-capability-contract.spec.ts', 'screenshot capability configured-vs-unconfigured, screenshot facade shape, provider selection (screenshotone/urlbox), screenshot of work website, gating'],
    ['flow-oauth-callback-security.spec.ts', 'OAuth callback security: state replay rejected, csrf-binding, redirect-uri pin, code reuse rejected, cross-provider token confusion prevented (mocked upstream)'],
    ['flow-search-capability-contract.spec.ts', 'search capability configured-vs-unconfigured, search facade shape, provider selection (tavily/brave/exa), search results contract, gating + per-work search'],
    ['flow-comparison-generator.spec.ts', 'comparison-generator utility: comparisonsEnabled flag, generate comparison (Trigger/AI-gated → adaptive), comparison count, comparison per work, comparison contract'],
    // ── templates & onboarding ──────────────────────────────────────
    ['flow-website-template-catalog.spec.ts', 'website-template catalog shape, select template for work (websiteTemplateId), template customization persistence, websiteTemplateAutoUpdate, useBeta, lastCommit/lastError'],
    ['flow-template-customization-deep.spec.ts', 'template customization apply→persist→render, theme/styling customization (compile-safe surface), customization per work isolation, reset customization, customization validation'],
    ['flow-template-auto-update.spec.ts', 'websiteTemplateAutoUpdate enable + lastUpdatedAt/lastCheckedAt, manual update check, update applies/skips, update error handling, beta channel'],
    ['flow-onboarding-wizard-deep.spec.ts', 'onboarding state→wizard steps→catalog choices→state advances (lastStep), step list derives from choices, dismiss (dismissedAt), completion (completedAt), badge logic'],
    ['flow-onboarding-catalog-choices.spec.ts', 'onboarding catalog (ai/git/deploy buckets), choosing Ever-Works-default vs BYOK affects step list, connection during onboarding, device-auth in onboarding'],
    ['flow-onboarding-telemetry.spec.ts', 'onboarding telemetry events accepted, telemetry opt-out, telemetry shape, step-completion tracking, telemetry isolation (probe; degrade if absent)'],
    ['flow-claim-landing-ui.spec.ts', 'claim landing /claim/<token> page renders offer (workName + role) on valid token, humanized error on invalid/used, accept from landing, baseURL-scoped nav (cookie host)'],
    // ── security & isolation ────────────────────────────────────────
    ['flow-cross-tenant-leak-matrix.spec.ts', 'cross-tenant data-leak matrix: two tenants × all resource types, every list endpoint returns only own rows, no leak via search/filter/pagination, no leak via id-guess'],
    ['flow-scope-guard-forbidden-matrix.spec.ts', 'scope-guard: user A cannot GET/PATCH/DELETE user B resource (work/agent/task/mission/skill/conversation/kb) — 403/404 on each verb×resource, no info leak in error'],
    ['flow-rate-limit-throttle.spec.ts', 'throttle enforcement: auth endpoints (login/magic-link 5/60s), 429 shape + Retry-After, throttle per-IP, throttle reset window, throttle does not affect other endpoints'],
    ['flow-csrf-cors-headers.spec.ts', 'CSRF double-submit cookie, CORS preflight allow-list (127.0.0.1+localhost), security headers (CSP/X-Frame/HSTS/Referrer-Policy), cookie security flags'],
    ['flow-injection-xss.spec.ts', 'XSS html-encoding in stored user content (work/task/comment names), CSV-injection on exports, SQL-injection-safe on search/filter params, path-traversal on file routes'],
    ['flow-redirect-open-prevention.spec.ts', 'open-redirect prevention on auth callbacks/email links/next-param, redirect allow-list, login redirect-back integrity, external redirect blocked'],
    ['flow-idor-resource-access.spec.ts', 'IDOR: sequential/guessable id access blocked across works/agents/tasks/invitations/conversations, sub-resource access requires parent access, cross-user sub-resource 403'],
    // ── i18n / a11y / errors ────────────────────────────────────────
    ['flow-i18n-locale-switching.spec.ts', 'locale switching (en/other), NEXT_LOCALE cookie, localePrefix never (unprefixed + /en both work), fallback to default, content translated, locale persists across nav'],
    ['flow-error-pages-localized.spec.ts', 'localized error pages (404/500/403), not-found catch-all, error-boundary isolation (one route error does not crash shell), error recovery, error page nav-back'],
    ['flow-a11y-key-flows-axe.spec.ts', 'accessibility (axe) on key authenticated flows (dashboard/works/tasks/agents/settings/chat panel) — no critical violations, keyboard navigation, focus management, ARIA on switcher/dialogs'],
    ['flow-seo-meta-deep.spec.ts', 'SEO meta/og/twitter tags on public pages, sitemap, robots, canonical, structured data, meta per locale, title templates'],
    ['flow-dark-mode-prefs.spec.ts', 'dark-mode toggle + persistence (cookie/localStorage), system preference, dark-mode across routes, no FOUC, theme on settings + chrome'],
    ['flow-breadcrumbs-navigation.spec.ts', 'breadcrumbs deep on nested routes (work>settings>budgets), breadcrumb links navigate, breadcrumb reflects entity names, breadcrumb on 404, keyboard nav of breadcrumbs'],
    ['flow-hydration-no-errors.spec.ts', 'no hydration/console errors on key routes, no FOUC, client-server consistency, suppressed-warning correctness, no unhandled promise rejections in console'],
    // ── platform meta ───────────────────────────────────────────────
    ['flow-health-degraded.spec.ts', 'health endpoint success + degraded/503 contract, readiness vs liveness, health does not require auth, health reflects dependency status (db/redis)'],
    ['flow-api-version-negotiation.spec.ts', 'api version header (gitSha/buildRun/buildTime), version endpoint shape, version negotiation/compat, deprecated-route headers, version on error responses'],
    ['flow-feature-flags-runtime.spec.ts', 'feature flags runtime: /api/config shape, flag-gated feature presence (MAGIC_LINK/SUBSCRIPTIONS), flag affects UI surface, flag default, flag per-env'],
    ['flow-config-public-contract.spec.ts', 'public config endpoint contract, no secrets leaked in config, config reflects env flags, config caching/etag, config per-locale'],
    ['flow-optimistic-concurrency.spec.ts', 'optimistic concurrency/conflict across entities (work/task/agent/mission): concurrent PATCH last-write or 409, etag/updatedAt precondition, conflict recovery'],
    ['flow-etag-cache-semantics.spec.ts', 'etag strong-vs-weak, conditional GET (If-None-Match 304), cache-control on public vs private routes, vary headers, cache-poisoning prevention'],
    ['flow-public-api-contract.spec.ts', 'public API contract (works-public/api-public): pagination, filtering, stable response shape, no auth required surfaces, rate-limit on public, content negotiation'],
];

// args.only = array of filenames to build THIS wave (idempotent — the caller
// passes only the files still missing from disk). Falls back to start/count
// slicing, then the whole list.
const wave = (args && typeof args === 'object') ? args : {};
let SLICE;
if (Array.isArray(wave.only) && wave.only.length) {
    const want = new Set(wave.only);
    SLICE = THEMES.filter(([file]) => want.has(file));
} else {
    const start = Number(wave.start || 0);
    const count = Number(wave.count || THEMES.length);
    SLICE = THEMES.slice(start, start + count);
}

const CONTEXT = `
You implement ONE themed Playwright e2e spec file of COMPLEX, multi-step, cross-feature END-TO-END
INTEGRATION flows for the Ever Works monorepo at C:/Coding/Worktrees/wt-e2e-real-integration
(apps/web/e2e/). FIRST do a mini gap-analysis for your theme, THEN implement ~6 uncovered flows.

The stack is RUNNING; the "setup" project saved authenticated storageState
(apps/web/e2e/.auth/user.json — the "seeded user"):
  - API:  http://127.0.0.1:3100   (NestJS, sqlite in-memory — CI driver)
  - Web:  http://127.0.0.1:3000   (Next.js dev)   MailHog: http://127.0.0.1:8025

STEPS:
1. SURVEY existing coverage for your theme so you do NOT duplicate:
   \`ls apps/web/e2e/ | grep -iE '<keywords>'\` and skim the matches (grep endpoints/describe titles).
   Build NEW complex flows that the existing specs do NOT already cover.
2. PROBE the LIVE API as a throwaway user before asserting (register → {access_token}; login DTO
   accepts ONLY {email,password}). READ the real controller/component source for EXACT endpoints,
   shapes, statuses, error messages, and UI selectors (apps/web/messages/en.json for i18n). If an
   endpoint/feature does NOT exist, implement the closest REAL flow + assert with .or()/skip-on-404
   and note it — never assert a fictional contract.
3. REUSE verified helpers under apps/web/e2e/helpers/: api.ts (API_BASE, authedHeaders,
   registerUserViaAPI, loginViaAPI, createWorkViaAPI), seeded-test-user.ts (loadSeededTestUser),
   organizations.ts, agents-tasks.ts, plugins.ts, chat.ts, profile.ts, mailhog.ts. Seeded bearer:
     const s = loadSeededTestUser();
     const { access_token } = await (await request.post(\`\${API_BASE}/api/auth/login\`, { data: { email: s.email, password: s.password } })).json();

TEMPLATES to copy structure/style: apps/web/e2e/flow-task-state-machine.spec.ts,
flow-agent-runs-history.spec.ts, flow-org-lifecycle-deep.spec.ts, flow-plugin-ai-matrix.spec.ts,
flow-chat-conversation-lifecycle.spec.ts, flow-multi-tenant-isolation.spec.ts.

HARD-WON GOTCHAS (violating = failing/flaky CI):
  - login DTO accepts ONLY {email,password} (extra {name} → 400).
  - NO LLM key + NO Trigger.dev in CI. Chat/AI = ENVIRONMENT-ADAPTIVE via isAiProviderConfigured():
    real reply when configured else truthful 422; /api/chat 200 SSE then stalls without key — never
    assert !ok, assert user msg rendered + composer alive. assign-task 500s at enqueue but STILL
    records an AgentRun — assert the run RECORD (listAgentRuns), never completion.
  - MAIL: e2e SMTP DELIVERY FAILS ("Missing credentials for PLAIN") though MailHog HTTP is up
    (isMailhogAvailable=true). Mailbox NEVER receives. Mail-content = BEST-EFFORT: validate IF a
    message arrives (waitForMessageTo non-null) else assert the API contract + annotate. Never
    HARD-require a delivered email. REQUIRE_EMAIL_VERIFICATION=false → no verification mail.
  - ANON CONTEXT: bare browser.newContext() INHERITS the storageState auth cookie. For unauth use
    newContext({ storageState: { cookies: [], origins: [] } }). Unauth /works/<id> 307s to /login.
  - next-dev LOCAL vs CI route divergence: some nested routes render in CI but 404 to catch-all
    LOCALLY → assert with locatorA.or(locatorB).first() and branch.
  - magic-link POST /api/auth/magic-link @Throttle 5/60s per-IP → tolerate/skip on 429. Duplicate
    POST /api/tasks/:id/assignees → 500 (uq_task_assignee). conversation message-append → 201. Works
    have NO soft-delete/archive/public-read; taxonomy/item writes git-gated (500/400). GET
    /api/organizations/:slug is a GLOBAL resolver (200 any authed user).
  - DEV HYDRATION RACE: retry-to-open headlessui dropdowns/dialogs (first click pre-hydration is
    swallowed) + 15-30s timeouts; a dialog WRAPPER reads HIDDEN → wait for a BUTTON inside it.
    Controlled React textareas: set value via native setter + dispatched 'input' event.
  - CROSS-SPEC ISOLATION: run plugin/settings/profile MUTATIONS on a FRESH registerUserViaAPI() user
    (NOT the shared seeded user — a user-scoped fake key shadows the env key + breaks sibling chat
    specs). Unique names/emails (Date.now suffix); assert toContain (tolerate pre-existing rows),
    never exact counts. Use the seeded user (storageState) ONLY for UI-driven assertions.
  - UI nav: derive origin from the baseURL fixture (\`baseURL ?? 'http://localhost:3000'\`); /dashboard
    does NOT exist (home is /). Routes unprefixed. Your assigned filename is flow- prefixed (safe vs
    the playwright.config no-auth testIgnore regex).

OUTPUT: write EXACTLY ONE new file at the assigned path, ~6 complex flows as separate test() cases
under test.describe with a top docblock of the probed shapes. Do NOT modify any other file. Do NOT
run \`pnpm exec playwright test\` (re-runs setup + contends the shared stack); curl read-only + read
source freely. TypeScript, import { test, expect } from '@playwright/test'. Repo style: tabs width 4,
single quotes, semicolons. Resilient: generous timeouts, .first(), expect.poll, toPass retry loops.
`;

phase('Build wave');

// NO schema: the success signal is the FILE ON DISK, not a structured return.
// (Forcing a StructuredOutput call made ~75% of agents "complete without
// calling it" under load even when they'd written the file.) The agent's final
// line is its plain-text note; we don't parse it — the orchestrator re-checks
// the filesystem after the wave and re-queues anything still missing.
const results = await parallel(
    SLICE.map(([file, focus]) => () =>
        agent(
            `${CONTEXT}\n\n=== YOUR ASSIGNED FILE ===\nWrite: apps/web/e2e/${file}\nFocus: ${focus}\n\nSurvey existing coverage for this focus, probe the live API/source, then implement ~6 uncovered COMPLEX flows as separate test() cases. Your ONLY deliverable is the file written to apps/web/e2e/${file}. When done, reply with a one-line confirmation (no structured output needed).`,
            { label: file.replace('flow-', '').replace('.spec.ts', '').slice(0, 40), phase: 'Build wave' },
        ).then(() => file).catch(() => null),
    ),
);
const done = results.filter(Boolean);
log(`Wave: ${done.length}/${SLICE.length} agents returned for [${SLICE.map((s) => s[0]).slice(0, 3).join(', ')}…]`);
return done;
