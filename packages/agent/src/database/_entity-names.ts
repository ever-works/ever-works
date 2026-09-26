/**
 * EW-638 — Single source of truth for the entity class NAMES exposed by the
 * `@ever-works/agent` entities barrel (`../entities`).
 *
 * Why a string-only list, separate from the real class registry:
 *
 *   `database.config.spec.ts` mocks the entire `../entities` barrel with
 *   stub classes — loading the real barrel under Jest triggers a known
 *   `path-scurry` init bug via TypeORM's CJS init path. The mock has to be
 *   declared inside `jest.mock(...)`'s factory and CAN'T import real entity
 *   classes (would re-trigger the bug).
 *
 *   So the spec needs an entity-name list that:
 *     - loads under Jest without dragging in TypeORM, and
 *     - stays in sync with the real entities barrel.
 *
 *   This file is that list. It exports a plain string array — nothing else.
 *   The spec uses `jest.requireActual('./_entity-names')` to read it inside
 *   the `jest.mock` factory, then synthesizes `{ Name: class Name {} }` from
 *   each entry.
 *
 *   Drift between THIS list and the real `../entities` barrel is detected
 *   by a dedicated spec in `database.module.spec.ts` (which already loads
 *   the real barrel, so the path-scurry constraint doesn't apply there).
 *
 * # When adding a new entity
 *
 *   1. Add its `export * from './<file>.entity'` to `../entities/index.ts`.
 *   2. Add its name (string) below — alphabetical insertion.
 *   3. If it should be registered with TypeORM's `forFeature(ENTITIES)`,
 *      also add the class to `database.config.ts`'s `ENTITIES` array.
 *
 *   The drift spec in `database.module.spec.ts` will fail loudly if you
 *   miss step 2 or 3.
 *
 * Excluded from this list:
 *   - `CacheEntry` (mocked under `../entities/cache.entity`, separate barrel)
 *   - Plugin entities (mocked under `../plugins/entities`)
 *   - Account-transfer entities (mocked under `../account-transfer/entities`)
 *
 *   Those barrels have their own jest.mock blocks in `database.config.spec.ts`
 *   and don't share this inventory.
 */

export const AGENT_ENTITY_NAMES: ReadonlyArray<string> = [
    'AgentPluginPackage',
    'AgentPluginPackageAllowlist',
    'ActivityLog',
    // Safety rails (AW-24) — one stored rung per (scope, kind of work).
    'AutonomyGrant',
    // Agents/Skills/Tasks (PR #1019) ──
    'Agent',
    'AgentActionProposal',
    'AgentAttachment',
    'AgentBudget',
    'AgentCollaborator',
    'AgentEmailAssignment',
    'AgentEscalation',
    // Agent email (AW-05) — per-Agent approval mode + send ceilings.
    'AgentInbox',
    // Agent Plugins MCP slice — per-agent/tenant MCP server bindings.
    'AgentMcpServerBinding',
    'AgentMembership',
    // Repository registry (Feature G) — Agent → repo grant edge rows.
    'AgentRepoAttachment',
    'AgentRun',
    'AgentRunLog',
    // ───────────────────────────────
    'ApiKey',
    // APW-11 App Launcher — one person's arrangement of one launcher item.
    'AppLauncherPreference',
    'AuthAccount',
    'AuthSession',
    'AuthVerification',
    // Payment provider bridge (billing PRD §5.3(3)/(4)) — customer +
    // payment-method summary + auto-recharge state, and the invoice mirror
    'BillingProfile',
    'CacheEntry',
    'ComposioTriggerSubscription',
    // Agent computers — live views of an Agent's Node
    'ComputerSession',
    'Conversation',
    'ConversationMessage',
    // Named Conversations — a person or an Agent taking part in one
    'ConversationParticipant',
    // Credits ledger (pricing Wave 9 M1)
    'CreditLedgerEntry',
    // Pay-as-you-go meter events (billing spec §3.5) — the platform-side
    // mirror of every credit reported to the provider's usage meter
    'CreditMeterEvent',
    'EmailConversation',
    'EmailMessage',
    // Environments (Settings → Environments) — named, reusable runtime
    // recipes (packages + networking) assigned per-Agent.
    'Environment',
    // Event-ingest spine — external tracker issue → platform Task mapping
    'ExternalIssueLink',
    'FleetAgentNodeAffinity',
    'FleetAudit',
    // Fleet local-runner routing — local-vs-cloud execution preference
    'FleetExecutionPreference',
    'FleetCostPolicy',
    // Fleet job runtime (Desktop PRD M4) — lease-able work for nodes
    'FleetJob',
    'FleetKillSwitch',
    // Fleet (Wave 12, slice 1) — enrolled execution nodes w/ heartbeat
    'FleetNode',
    'GitHubAppInstallation',
    'GitHubAppInstallationRepository',
    'GitHubAppUserLink',
    // Inbound Triggers (Trigger Schedules) — signed webhook/API triggers
    'InboundTrigger',
    // Task Triggers — per-(trigger, event) fire ledger (ingest idempotency)
    'InboundTriggerFire',
    // Inbox (operator message center) — messages addressed to the human
    'InboxItem',
    // Event-ingest pull path (Wave 8) — per-(user, plugin) pull cursors
    'IngestCursor',
    // Inbound receivers — workspace/installation → platform user binding
    'IngestInstallBinding',
    // Event-ingest spine (Wave 6) — normalized external events
    'IngestedEvent',
    // Memory eval loop (memory upgrades M10) — append-only retrieval log
    'KbRetrievalLog',
    // Knowledge library — per-person read state + pins on KB documents
    'KnowledgeDocumentReaderState',
    // Invoice mirror (billing PRD §3.5) — provider invoices/receipts,
    // written only by the signature-verified webhook
    'Invoice',
    // Durable self-hosted commercial-licence ownership.
    'LicencePurchase',
    // Agent Plugins MCP slice — manual external MCP server registry.
    'McpServerConnection',
    // Meetings v1 (Wave 8, feature a) — captured meetings w/ transcripts
    'Meeting',
    // AW-07 — Memory facts (atomic tier of Memory)
    'MemoryFact',
    // Memory Files — user-defined folders organizing uploads on /memory
    'MemoryFolder',
    'Mission',
    // Model accounts (AW-16) — provider accounts + the model ladder.
    'ModelAccount',
    'ModelPolicy',
    // Domain-model evolution PR-8 — Goals + measurement
    'Goal',
    'GoalMetricSample',
    'GoalEvent',
    'MissionGoal',
    'MissionAttachment',
    'MissionWork',
    'IdeaWork',
    // Agent computers — each Agent's own profile on each Node
    'NodeAgentProfile',
    'Notification',
    'NotificationChannel',
    'NotificationChannelDeliveryLog',
    'NotificationEventType',
    'OnboardingChecklist',
    'OnboardingRequest',
    'Organization',
    'OrganizationNotificationDefault',
    'OrganizationOnboardingProfile',
    // Plan entitlements (pricing Wave 9 M1)
    'PlanEntitlement',
    'PluginUsageEvent',
    // AW-14 What's new — per-person read state for product changelog entries.
    'ProductChangelogRead',
    // Safety rails (AW-24) — the durable record of what the rails stopped.
    'RailRefusal',
    'RefreshToken',
    // Release promotion lane (self-build slice AI, EW-808).
    'ReleasePromotion',
    // Repository registry (Feature G) — account-level repo records.
    'RepoConnection',
    // AW-18 Shared view — one Workspace's read-only published face.
    'SharedView',
    // Skills family (PR #1019) ──
    'Skill',
    'SkillBinding',
    'SkillFile',
    'SkillTag',
    // ───────────────────────────
    'SubscriptionPlan',
    // Tasks family (PR #1019) ──
    'Task',
    // Reviewer agent stage (slice AD, EW-811) - the review ledger.
    'TaskAgentReview',
    'TaskApprover',
    'TaskAssignee',
    'TaskAttachment',
    'TaskBlock',
    'TaskChatMessage',
    'TaskCiAutoResumeAttempt',
    'TaskKbMention',
    'TaskRelation',
    'TaskReviewRejection',
    'TaskReviewer',
    // Tasks upgrades — workflow templates (parent + steps).
    'TaskTemplate',
    'TaskTemplateStep',
    'TaskWatcher',
    // ──────────────────────────
    // Teams & Prebuilt Companies (teams-and-companies spec §2) ──
    'Team',
    'TeamMember',
    'TeamResource',
    // ──────────────────────────
    'Template',
    'TemplateCustomization',
    'Tenant',
    'TenantEmailAddress',
    // Tenant-scoped job-runtime overlay (EW-742 P1 / EW-745) ──
    'TenantCredentialSnapshot',
    'TenantJobRuntimeAudit',
    'TenantJobRuntimeConfig',
    'TenantRuntimeProviderAllowlist',
    // ──────────────────────────────────────────────────────────
    // Streaming-terminal M9 / D1 — persisted terminal transcripts.
    'TerminalTranscriptChunk',
    // Signup terms acceptance — one immutable row per accepted document.
    // Already in `_entities-inventory.ts`; this list was the missed half
    // of the two-step registration.
    'TermsAcceptance',
    // Tool-grant matrix (audit item G4) — per-scope tool allow/deny rows.
    'ToolGrant',
    'UsageLedgerEntry',
    'User',
    'UserNotificationCategoryMute',
    'UserNotificationPreference',
    'UserNotificationSubscription',
    'UserSubscription',
    'UserTaskCounter',
    'UserTemplatePreference',
    'UserUpload',
    // AW-07 — pgvector chunks for vector namespaces that are not a Work
    'VectorNamespaceChunk',
    'WebhookDelivery',
    'WebhookSubscription',
    'Work',
    'WorkAdvancedPrompts',
    'WorkAgentPreference',
    'WorkAgentRun',
    'WorkAgentRunLog',
    // APW-07 App env & dependencies — one encrypted value per (Work, name),
    // and one row per (Work, kind) recording what a provider provisioned.
    'WorkAppDependency',
    'WorkAppEnvValue',
    // APW-03 App spec & catalog — the per-App-Work spec state row.
    'WorkAppSpecState',
    // APW-04 App Provisioner — one row per provisioning attempt of an App Work.
    'WorkAppProvisioning',
    // APW-06 T17 — one per App Work: target, namespace, cluster fingerprint,
    // the atomic deploy lock and its queue of one, health counters and the
    // deletion claim.
    'WorkAppRuntimeState',
    'WorkBudget',
    'WorkBudgetAlertState',
    // APW-05 Builds — one row per Build of an App Work (per-Work numbering),
    // and the per-App-Work preparation state that is derived, never API-written.
    'WorkBuild',
    'WorkBuildPreparation',
    'WorkBuildRequest',
    'WorkCustomDomain',
    'WorkDeployment',
    'WorkGenerationHistory',
    'WorkInvitation',
    'OrganizationInvitation',
    'OrganizationMember',
    'WorkKnowledgeChunk',
    'WorkKnowledgeChunkCoordinate',
    'WorkKnowledgeCitation',
    'WorkKnowledgeDocument',
    'WorkKnowledgeTag',
    'WorkKnowledgeUpload',
    'WorkMember',
    'WorkProposal',
    'WorkProposalAttachment',
    'WorkSchedule',
    // APW-02 Fork lifecycle — one per App Work; readiness through sync.
    'WorkUpstreamState',
    'Workflow',
    'WorkflowRun',
    'WorkspaceBackup',
    // Safety rails (AW-24) — present only while a workspace is paused.
    'WorkspacePause',
] as const;
