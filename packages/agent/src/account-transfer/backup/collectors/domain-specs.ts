import type { BackupDomainSpec } from './collector.types';

/**
 * Workspace backup (AW-22) — what each of the fifteen domains contains.
 *
 * This table is the archive's coverage, written down in one place so a
 * reviewer can check it against spec FR-13 without reading fifteen query
 * walks, and so the manifest cannot claim a file the writer never produced.
 *
 * Reading a row:
 *
 *   { file: 'agents.jsonl', entity: 'Agent', scope: { by: 'workspace' } }
 *
 * means `data/agents/agents.jsonl` holds every `Agent` row belonging to this
 * workspace — this person AND this organization, or `organizationId IS NULL`
 * when the workspace is the un-organized one.
 *
 * Child tables that carry no scope column of their own are reached through
 * `{ by: 'parent' }` and the ids their parent registered. That is what makes
 * "this table has no `userId`" safe: the ids came from a query that was
 * already narrowed, so the child cannot reach further than the parent did.
 * Order matters for exactly this reason — a `parent` file must come after
 * the file that registers its ids.
 *
 * `personalScope` is the rule a file uses instead when the workspace has no
 * organization. An `organization`-scoped table whose `organizationId` is
 * NULL until its owner creates an organization carries one, naming the
 * owner column (or the owner's parent ids) that tells this person's rows
 * from everyone else's — so an un-organized owner's webhooks, code-host
 * installations, onboarding requests and email conversations ship, and a
 * stranger's never do. An `organization` file without one is written empty
 * in that workspace, and reported as a gap unless its `organizationId` is
 * NOT NULL.
 *
 * `trim` names a policy in `BACKUP_TRIM_POLICIES`; the cutoff and the number
 * of rows left out are recorded per file in the manifest (spec FR-14).
 *
 * `bytes` marks a table whose rows point at stored file bytes; the runner
 * queues them for `files/<id>/<filename>` until the attachment budget is
 * reached (spec FR-15, FR-23).
 */
export const BACKUP_DOMAIN_SPECS: readonly BackupDomainSpec[] = Object.freeze([
    // ── D1 · Account and profile ────────────────────────────────────────
    // Restorable except key material, which never leaves (spec FR-18.3):
    // API keys appear as name, prefix and active flag only.
    {
        key: 'account' as const,
        files: Object.freeze([
            {
                file: 'profile.jsonl',
                entity: 'User',
                scope: { by: 'owner' as const, of: 'account' as const },
            },
            { file: 'api-keys.jsonl', entity: 'ApiKey', scope: { by: 'workspace' as const } },
            {
                file: 'terms-acceptance.jsonl',
                entity: 'TermsAcceptance',
                scope: { by: 'user' as const },
            },
            {
                file: 'notification-preferences.jsonl',
                entity: 'UserNotificationPreference',
                scope: { by: 'user' as const },
            },
            {
                file: 'notification-subscriptions.jsonl',
                entity: 'UserNotificationSubscription',
                scope: { by: 'user' as const },
            },
            {
                file: 'notification-mutes.jsonl',
                entity: 'UserNotificationCategoryMute',
                scope: { by: 'user' as const },
            },
            {
                file: 'template-preferences.jsonl',
                entity: 'UserTemplatePreference',
                scope: { by: 'user' as const },
            },
            {
                file: 'onboarding.jsonl',
                entity: 'OnboardingRequest',
                scope: { by: 'organization' as const },
                // Personal: the owner's own requests, never an unassigned
                // stranger's. See `BackupFileSpec.personalScope`.
                personalScope: { by: 'workspace' as const, userColumn: 'accountId' },
            },
            // APW-11 (T30) — the App Launcher's per-person arrangement. `by: 'user'` because a row
            // is keyed by `userId` + `scopeKey` (`'global' | 'personal' | <organizationId>`), so an
            // organisation-scoped preference travels with the *person*: the launcher is a personal
            // panel and a restored account must come back with the same pinned tiles and order.
            // Nothing in the row is secret — item keys, order positions, a visible flag, a pin flag.
            {
                file: 'app-launcher-preferences.jsonl',
                entity: 'AppLauncherPreference',
                scope: { by: 'user' as const },
            },
        ]),
    },

    // ── D2 · Organizations and teams ────────────────────────────────────
    {
        key: 'organizations' as const,
        files: Object.freeze([
            {
                file: 'organization.jsonl',
                entity: 'Organization',
                scope: { by: 'owner' as const, of: 'organization' as const },
            },
            {
                file: 'members.jsonl',
                entity: 'OrganizationMember',
                scope: { by: 'organization' as const },
            },
            {
                file: 'invitations.jsonl',
                entity: 'OrganizationInvitation',
                scope: { by: 'organization' as const },
            },
            {
                file: 'onboarding-profile.jsonl',
                entity: 'OrganizationOnboardingProfile',
                scope: { by: 'organization' as const },
            },
            {
                file: 'notification-defaults.jsonl',
                entity: 'OrganizationNotificationDefault',
                scope: { by: 'organization' as const },
            },
            {
                file: 'teams.jsonl',
                entity: 'Team',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'teamIds',
            },
            {
                file: 'team-members.jsonl',
                entity: 'TeamMember',
                scope: { by: 'parent' as const, column: 'teamId', from: 'teamIds' },
            },
            {
                file: 'team-resources.jsonl',
                entity: 'TeamResource',
                scope: { by: 'parent' as const, column: 'teamId', from: 'teamIds' },
            },
        ]),
    },

    // ── D3 · Agents and skills ──────────────────────────────────────────
    {
        key: 'agents' as const,
        files: Object.freeze([
            {
                file: 'agents.jsonl',
                entity: 'Agent',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'agentIds',
            },
            {
                file: 'memberships.jsonl',
                entity: 'AgentMembership',
                scope: { by: 'parent' as const, column: 'agentId', from: 'agentIds' },
            },
            {
                file: 'collaborators.jsonl',
                entity: 'AgentCollaborator',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'budgets.jsonl',
                entity: 'AgentBudget',
                scope: { by: 'parent' as const, column: 'agentId', from: 'agentIds' },
            },
            {
                file: 'repo-attachments.jsonl',
                entity: 'AgentRepoAttachment',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'mcp-bindings.jsonl',
                entity: 'AgentMcpServerBinding',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'email-assignments.jsonl',
                entity: 'AgentEmailAssignment',
                scope: { by: 'parent' as const, column: 'agentId', from: 'agentIds' },
            },
            {
                file: 'attachments.jsonl',
                entity: 'AgentAttachment',
                scope: { by: 'parent' as const, column: 'agentId', from: 'agentIds' },
            },
            { file: 'tool-grants.jsonl', entity: 'ToolGrant', scope: { by: 'workspace' as const } },
            {
                file: 'skills.jsonl',
                entity: 'Skill',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'skillIds',
            },
            {
                file: 'skill-bindings.jsonl',
                entity: 'SkillBinding',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'skill-files.jsonl',
                entity: 'SkillFile',
                scope: { by: 'workspace' as const },
            },
        ]),
    },

    // ── D4 · Missions, goals and ideas ──────────────────────────────────
    {
        key: 'missions' as const,
        files: Object.freeze([
            {
                file: 'missions.jsonl',
                entity: 'Mission',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'missionIds',
            },
            {
                file: 'mission-goals.jsonl',
                entity: 'MissionGoal',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'mission-works.jsonl',
                entity: 'MissionWork',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'mission-attachments.jsonl',
                entity: 'MissionAttachment',
                scope: { by: 'parent' as const, column: 'missionId', from: 'missionIds' },
            },
            {
                file: 'goals.jsonl',
                entity: 'Goal',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'goalIds',
            },
            { file: 'goal-events.jsonl', entity: 'GoalEvent', scope: { by: 'workspace' as const } },
            {
                file: 'goal-metric-samples.jsonl',
                entity: 'GoalMetricSample',
                scope: { by: 'parent' as const, column: 'goalId', from: 'goalIds' },
            },
            { file: 'idea-works.jsonl', entity: 'IdeaWork', scope: { by: 'workspace' as const } },
        ]),
    },

    // ── D5 · Tasks and workflows ────────────────────────────────────────
    {
        key: 'tasks' as const,
        files: Object.freeze([
            {
                file: 'tasks.jsonl',
                entity: 'Task',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'taskIds',
            },
            {
                file: 'assignees.jsonl',
                entity: 'TaskAssignee',
                scope: { by: 'parent' as const, column: 'taskId', from: 'taskIds' },
            },
            {
                file: 'approvers.jsonl',
                entity: 'TaskApprover',
                scope: { by: 'parent' as const, column: 'taskId', from: 'taskIds' },
            },
            {
                file: 'reviewers.jsonl',
                entity: 'TaskReviewer',
                scope: { by: 'parent' as const, column: 'taskId', from: 'taskIds' },
            },
            { file: 'watchers.jsonl', entity: 'TaskWatcher', scope: { by: 'workspace' as const } },
            {
                file: 'blocks.jsonl',
                entity: 'TaskBlock',
                scope: { by: 'parent' as const, column: 'taskId', from: 'taskIds' },
            },
            {
                file: 'relations.jsonl',
                entity: 'TaskRelation',
                scope: { by: 'parent' as const, column: 'taskId', from: 'taskIds' },
            },
            {
                file: 'chat.jsonl',
                entity: 'TaskChatMessage',
                scope: { by: 'parent' as const, column: 'taskId', from: 'taskIds' },
            },
            {
                file: 'attachments.jsonl',
                entity: 'TaskAttachment',
                scope: { by: 'parent' as const, column: 'taskId', from: 'taskIds' },
            },
            {
                file: 'kb-mentions.jsonl',
                entity: 'TaskKbMention',
                scope: { by: 'parent' as const, column: 'taskId', from: 'taskIds' },
            },
            {
                file: 'review-rejections.jsonl',
                entity: 'TaskReviewRejection',
                scope: { by: 'parent' as const, column: 'taskId', from: 'taskIds' },
            },
            {
                file: 'templates.jsonl',
                entity: 'TaskTemplate',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'taskTemplateIds',
            },
            {
                file: 'template-steps.jsonl',
                entity: 'TaskTemplateStep',
                scope: { by: 'parent' as const, column: 'templateId', from: 'taskTemplateIds' },
            },
            { file: 'workflows.jsonl', entity: 'Workflow', scope: { by: 'workspace' as const } },
        ]),
    },

    // ── D6 · Works ──────────────────────────────────────────────────────
    // The Work rows. The per-Work snapshot of items/categories/tags out of
    // each Work's own data repo is deliberately NOT read here: there must be
    // exactly one implementation of that walk, and it lives on
    // `AccountExportService`. See the module header of `../workspace-backup-runner.ts`.
    {
        key: 'works' as const,
        files: Object.freeze([
            {
                file: 'works.jsonl',
                entity: 'Work',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'workIds',
            },
            { file: 'members.jsonl', entity: 'WorkMember', scope: { by: 'workspace' as const } },
            {
                file: 'custom-domains.jsonl',
                entity: 'WorkCustomDomain',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            {
                file: 'advanced-prompts.jsonl',
                entity: 'WorkAdvancedPrompts',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            {
                file: 'budgets.jsonl',
                entity: 'WorkBudget',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            {
                file: 'budget-alerts.jsonl',
                entity: 'WorkBudgetAlertState',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            {
                file: 'plugins.jsonl',
                entity: 'WorkPluginEntity',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            {
                file: 'deployments.jsonl',
                entity: 'WorkDeployment',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            {
                file: 'generation-history.jsonl',
                entity: 'WorkGenerationHistory',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'build-requests.jsonl',
                entity: 'WorkBuildRequest',
                scope: { by: 'user' as const },
            },
            {
                file: 'invitations.jsonl',
                entity: 'WorkInvitation',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            { file: 'proposals.jsonl', entity: 'WorkProposal', scope: { by: 'user' as const } },
            {
                file: 'agent-preferences.jsonl',
                entity: 'WorkAgentPreference',
                scope: { by: 'user' as const },
            },
            {
                file: 'release-promotions.jsonl',
                entity: 'ReleasePromotion',
                scope: { by: 'workspace' as const },
            },
        ]),
    },

    // ── D7 · Knowledge and memory ───────────────────────────────────────
    // The only domain that carries BYTES as well as rows: the uploads behind
    // knowledge documents, and everything on /memory.
    {
        key: 'knowledge' as const,
        files: Object.freeze([
            {
                file: 'documents.jsonl',
                entity: 'WorkKnowledgeDocument',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            {
                file: 'tags.jsonl',
                entity: 'WorkKnowledgeTag',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            {
                file: 'citations.jsonl',
                entity: 'WorkKnowledgeCitation',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
            },
            {
                file: 'uploads.jsonl',
                entity: 'WorkKnowledgeUpload',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
                bytes: {
                    keyColumn: 'storagePath',
                    nameColumn: 'originalFilename',
                    sizeColumn: 'fileSize',
                },
            },
            {
                file: 'memory-folders.jsonl',
                entity: 'MemoryFolder',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'user-uploads.jsonl',
                entity: 'UserUpload',
                scope: { by: 'workspace' as const },
                bytes: {
                    keyColumn: 'storagePath',
                    nameColumn: 'originalFilename',
                    sizeColumn: 'fileSize',
                },
            },
            {
                file: 'retrieval-log.jsonl',
                entity: 'KbRetrievalLog',
                scope: { by: 'parent' as const, column: 'workId', from: 'workIds' },
                trim: 'retrievalTrail' as const,
            },
        ]),
    },

    // ── D8 · Schedules and triggers ─────────────────────────────────────
    // Restorable, with signing secrets regenerated: the secret columns are
    // redacted to `{ wasSet }` on the way out (spec FR-18.4).
    {
        key: 'schedules' as const,
        files: Object.freeze([
            {
                file: 'work-schedules.jsonl',
                entity: 'WorkSchedule',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'inbound-triggers.jsonl',
                entity: 'InboundTrigger',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'triggerIds',
            },
            {
                file: 'trigger-fires.jsonl',
                entity: 'InboundTriggerFire',
                scope: { by: 'parent' as const, column: 'triggerId', from: 'triggerIds' },
                trim: 'triggerFires' as const,
            },
            {
                file: 'composio-subscriptions.jsonl',
                entity: 'ComposioTriggerSubscription',
                scope: { by: 'workspace' as const },
            },
        ]),
    },

    // ── D9 · Runs and receipts ──────────────────────────────────────────
    // Record only. Restoring a run would fabricate a past that did not
    // happen in the target workspace (spec FR-36).
    {
        key: 'runs' as const,
        files: Object.freeze([
            {
                file: 'agent-runs.jsonl',
                entity: 'AgentRun',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'agentRunIds',
            },
            {
                file: 'run-logs.jsonl',
                entity: 'AgentRunLog',
                scope: { by: 'parent' as const, column: 'runId', from: 'agentRunIds' },
                trim: 'runLogs' as const,
            },
            {
                file: 'terminal-transcripts.jsonl',
                entity: 'TerminalTranscriptChunk',
                scope: { by: 'parent' as const, column: 'runId', from: 'agentRunIds' },
                trim: 'terminalTranscripts' as const,
            },
            {
                file: 'computer-sessions.jsonl',
                entity: 'ComputerSession',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'work-agent-runs.jsonl',
                entity: 'WorkAgentRun',
                scope: { by: 'user' as const },
                registerIdsAs: 'workAgentRunIds',
            },
            {
                file: 'work-agent-run-logs.jsonl',
                entity: 'WorkAgentRunLog',
                scope: { by: 'parent' as const, column: 'runId', from: 'workAgentRunIds' },
                trim: 'runLogs' as const,
            },
            {
                file: 'workflow-runs.jsonl',
                entity: 'WorkflowRun',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'plugin-usage-events.jsonl',
                entity: 'PluginUsageEvent',
                scope: { by: 'workspace' as const },
                trim: 'pluginUsageEvents' as const,
            },
        ]),
    },

    // ── D10 · Decisions ─────────────────────────────────────────────────
    {
        key: 'decisions' as const,
        files: Object.freeze([
            {
                file: 'escalations.jsonl',
                entity: 'AgentEscalation',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'action-proposals.jsonl',
                entity: 'AgentActionProposal',
                scope: { by: 'workspace' as const },
            },
            { file: 'inbox.jsonl', entity: 'InboxItem', scope: { by: 'workspace' as const } },
        ]),
    },

    // ── D11 · Communication ─────────────────────────────────────────────
    // Partly restorable: addresses and preferences come back, message
    // history stays a record. Channel endpoints are redacted.
    {
        key: 'communication' as const,
        files: Object.freeze([
            {
                file: 'email-addresses.jsonl',
                entity: 'TenantEmailAddress',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'agent-inboxes.jsonl',
                entity: 'AgentInbox',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'email-conversations.jsonl',
                entity: 'EmailConversation',
                scope: { by: 'organization' as const },
                // Personal: the conversations of the owner's own agents,
                // which is also what `email-messages.jsonl` points at — so
                // no message in the archive names a conversation it lacks.
                personalScope: { by: 'parent' as const, column: 'agentId', from: 'agentIds' },
            },
            {
                file: 'email-messages.jsonl',
                entity: 'EmailMessage',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'notifications.jsonl',
                entity: 'Notification',
                scope: { by: 'workspace' as const },
                trim: 'notifications' as const,
            },
            {
                file: 'channels.jsonl',
                entity: 'NotificationChannel',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'channelIds',
            },
            {
                file: 'channel-deliveries.jsonl',
                entity: 'NotificationChannelDeliveryLog',
                scope: { by: 'parent' as const, column: 'channelId', from: 'channelIds' },
                trim: 'deliveryLogs' as const,
            },
            { file: 'meetings.jsonl', entity: 'Meeting', scope: { by: 'workspace' as const } },
            {
                file: 'conversations.jsonl',
                entity: 'Conversation',
                scope: { by: 'workspace' as const },
            },
        ]),
    },

    // ── D12 · Connections and environments ──────────────────────────────
    // Restorable with credentials re-entered: every secret column is
    // redacted to `{ wasSet }`, so the archive says WHICH connections need a
    // credential without carrying one (spec FR-40's input).
    {
        key: 'connections' as const,
        files: Object.freeze([
            {
                file: 'user-plugins.jsonl',
                entity: 'UserPluginEntity',
                scope: { by: 'user' as const },
            },
            {
                file: 'mcp-connections.jsonl',
                entity: 'McpServerConnection',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'repo-connections.jsonl',
                entity: 'RepoConnection',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'environments.jsonl',
                entity: 'Environment',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'code-host-installations.jsonl',
                entity: 'GitHubAppInstallation',
                scope: { by: 'organization' as const },
                personalScope: { by: 'workspace' as const, userColumn: 'createdByUserId' },
            },
            {
                file: 'code-host-links.jsonl',
                entity: 'GitHubAppUserLink',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'webhook-subscriptions.jsonl',
                entity: 'WebhookSubscription',
                scope: { by: 'organization' as const },
                personalScope: { by: 'workspace' as const, userColumn: 'accountId' },
                registerIdsAs: 'webhookIds',
            },
            {
                file: 'webhook-deliveries.jsonl',
                entity: 'WebhookDelivery',
                scope: { by: 'parent' as const, column: 'subscriptionId', from: 'webhookIds' },
                trim: 'deliveryLogs' as const,
            },
            {
                file: 'ingest-bindings.jsonl',
                entity: 'IngestInstallBinding',
                scope: { by: 'user' as const },
            },
            {
                file: 'ingest-cursors.jsonl',
                entity: 'IngestCursor',
                scope: { by: 'user' as const },
            },
            {
                file: 'external-issue-links.jsonl',
                entity: 'ExternalIssueLink',
                scope: { by: 'workspace' as const },
            },
        ]),
    },

    // ── D13 · Fleet ─────────────────────────────────────────────────────
    // The inventory is a record only — a node is a physical machine that
    // must enrol itself — while the execution preferences and the
    // agent-to-node pinning come back.
    {
        key: 'fleet' as const,
        files: Object.freeze([
            {
                file: 'nodes.jsonl',
                entity: 'FleetNode',
                scope: { by: 'workspace' as const },
                registerIdsAs: 'nodeIds',
            },
            {
                file: 'execution-preferences.jsonl',
                entity: 'FleetExecutionPreference',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'agent-affinities.jsonl',
                entity: 'FleetAgentNodeAffinity',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'node-agent-profiles.jsonl',
                entity: 'NodeAgentProfile',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'jobs.jsonl',
                entity: 'FleetJob',
                scope: { by: 'workspace' as const },
                trim: 'fleetJobs' as const,
            },
        ]),
    },

    // ── D14 · Billing and usage record ──────────────────────────────────
    // Record only. A balance is earned in one account and cannot be minted
    // by importing a file (spec S-22). Every payment-provider identifier is
    // dropped on the way out (spec FR-18.6).
    {
        key: 'billing' as const,
        files: Object.freeze([
            {
                file: 'profile.jsonl',
                entity: 'BillingProfile',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'subscription.jsonl',
                entity: 'UserSubscription',
                scope: { by: 'workspace' as const },
            },
            { file: 'invoices.jsonl', entity: 'Invoice', scope: { by: 'workspace' as const } },
            {
                file: 'credit-ledger.jsonl',
                entity: 'CreditLedgerEntry',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'usage-ledger.jsonl',
                entity: 'UsageLedgerEntry',
                scope: { by: 'workspace' as const },
            },
            {
                file: 'licence-purchases.jsonl',
                entity: 'LicencePurchase',
                scope: { by: 'user' as const },
            },
        ]),
    },

    // ── D15 · Activity ──────────────────────────────────────────────────
    {
        key: 'activity' as const,
        files: Object.freeze([
            {
                file: 'activity.jsonl',
                entity: 'ActivityLog',
                scope: { by: 'workspace' as const },
                trim: 'activity' as const,
            },
        ]),
    },
]);

/** Every entity name the table references, for the coverage guard. */
export function referencedEntities(): readonly string[] {
    return [
        ...new Set(
            BACKUP_DOMAIN_SPECS.flatMap((domain) => domain.files.map((file) => file.entity)),
        ),
    ];
}
