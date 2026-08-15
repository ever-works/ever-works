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
    'ActivityLog',
    // Agents/Skills/Tasks (PR #1019) ──
    'Agent',
    'AgentActionProposal',
    'AgentAttachment',
    'AgentBudget',
    'AgentCollaborator',
    'AgentEmailAssignment',
    'AgentEscalation',
    'AgentMembership',
    'AgentRun',
    'AgentRunLog',
    // ───────────────────────────────
    'ApiKey',
    'AuthAccount',
    'AuthSession',
    'AuthVerification',
    // Payment provider bridge (billing PRD §5.3(3)/(4)) — customer +
    // payment-method summary + auto-recharge state, and the invoice mirror
    'BillingProfile',
    'CacheEntry',
    'ComposioTriggerSubscription',
    'Conversation',
    'ConversationMessage',
    // Credits ledger (pricing Wave 9 M1)
    'CreditLedgerEntry',
    'EmailConversation',
    'EmailMessage',
    // Event-ingest spine — external tracker issue → platform Task mapping
    'ExternalIssueLink',
    // Fleet local-runner routing — local-vs-cloud execution preference
    'FleetExecutionPreference',
    // Fleet job runtime (Desktop PRD M4) — lease-able work for nodes
    'FleetJob',
    // Fleet (Wave 12, slice 1) — enrolled execution nodes w/ heartbeat
    'FleetNode',
    'GitHubAppInstallation',
    'GitHubAppInstallationRepository',
    'GitHubAppUserLink',
    // Inbound Triggers (Trigger Schedules) — signed webhook/API triggers
    'InboundTrigger',
    // Task Triggers — per-(trigger, event) fire ledger (ingest idempotency)
    'InboundTriggerFire',
    // Event-ingest pull path (Wave 8) — per-(user, plugin) pull cursors
    'IngestCursor',
    // Inbound receivers — workspace/installation → platform user binding
    'IngestInstallBinding',
    // Event-ingest spine (Wave 6) — normalized external events
    'IngestedEvent',
    // Memory eval loop (memory upgrades M10) — append-only retrieval log
    'KbRetrievalLog',
    // Invoice mirror (billing PRD §3.5) — provider invoices/receipts,
    // written only by the signature-verified webhook
    'Invoice',
    // Meetings v1 (Wave 8, feature a) — captured meetings w/ transcripts
    'Meeting',
    // Memory Files — user-defined folders organizing uploads on /memory
    'MemoryFolder',
    'Mission',
    // Domain-model evolution PR-8 — Goals + measurement
    'Goal',
    'GoalMetricSample',
    'MissionGoal',
    'MissionAttachment',
    'MissionWork',
    'IdeaWork',
    'Notification',
    'NotificationChannel',
    'NotificationChannelDeliveryLog',
    'NotificationEventType',
    'OnboardingRequest',
    'Organization',
    'OrganizationNotificationDefault',
    'OrganizationOnboardingProfile',
    // Plan entitlements (pricing Wave 9 M1)
    'PlanEntitlement',
    'PluginUsageEvent',
    'RefreshToken',
    // Skills family (PR #1019) ──
    'Skill',
    'SkillBinding',
    'SkillFile',
    // ───────────────────────────
    'SubscriptionPlan',
    // Tasks family (PR #1019) ──
    'Task',
    'TaskApprover',
    'TaskAssignee',
    'TaskAttachment',
    'TaskBlock',
    'TaskChatMessage',
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
    'WebhookDelivery',
    'WebhookSubscription',
    'Work',
    'WorkAdvancedPrompts',
    'WorkAgentPreference',
    'WorkAgentRun',
    'WorkAgentRunLog',
    'WorkBudget',
    'WorkBudgetAlertState',
    'WorkBuildRequest',
    'WorkCustomDomain',
    'WorkDeployment',
    'WorkGenerationHistory',
    'WorkInvitation',
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
    'Workflow',
    'WorkflowRun',
] as const;
