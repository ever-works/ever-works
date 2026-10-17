/**
 * Event-coverage registry (EW-P1-1, `docs/specs/features/domain-events/spec.md` §3 "Coverage gate").
 *
 * Every mutating route (POST / PUT / PATCH / DELETE) of a controller in the
 * domain-event scope must appear here, either with the catalog events it
 * records or with the reason it records none. `domain-event-route-coverage.spec.ts`
 * reads the routes from the controllers' decorators and fails CI when a
 * route is missing from this table — so a new mutating route cannot ship
 * without someone deciding what event it records.
 *
 * The behaviour behind each `events` entry is pinned by the services' own
 * recording specs.
 */
export type RouteCoverage = { readonly events: readonly string[] } | { readonly exempt: string };

const WORK_CONTENT =
    'Content, generation, deploy or runtime state of the Work (data repository, website, schedules, items) — not part of the work integration DTO.';

/** `METHOD /full/path` → what it records. */
export const DOMAIN_EVENT_ROUTE_COVERAGE: Readonly<Record<string, RouteCoverage>> = {
    // ── Tasks (`api/tasks`) ──────────────────────────────────────────────────
    'POST /api/tasks': { events: ['task.created'] },
    'POST /api/tasks/run-batch': { events: ['task.runtime_updated'] },
    'PATCH /api/tasks/:id': { events: ['task.updated'] },
    'DELETE /api/tasks/:id': { events: ['task.deleted'] },
    'POST /api/tasks/:id/recurring': { events: ['task.updated'] },
    'POST /api/tasks/:id/recurring/run-now': { events: ['task.created'] },
    'POST /api/tasks/:id/schedule': { events: ['task.updated'] },
    'DELETE /api/tasks/:id/schedule': { events: ['task.updated'] },
    'DELETE /api/tasks/:id/recurring': { events: ['task.updated'] },
    'POST /api/tasks/:id/transition': { events: ['task.transitioned'] },
    'POST /api/tasks/:id/run': { events: ['task.runtime_updated'] },
    'POST /api/tasks/:id/resolve-conflicts': { events: ['task.transitioned'] },
    'POST /api/tasks/:id/discard-branch': { events: ['task.runtime_updated'] },
    'POST /api/tasks/:id/assignees': { events: ['task.assignee.added'] },
    'DELETE /api/tasks/:id/assignees/:assigneeId': { events: ['task.assignee.removed'] },
    'POST /api/tasks/:id/reviewers': { events: ['task.updated'] },
    'POST /api/tasks/:id/reject': { events: ['task.updated'] },
    // Resolving the escalation closes its Inbox mirror (EW-P3-1 `escalationResolved`).
    'POST /api/tasks/:id/escalations/:escalationId/resolve': { events: ['inbox.item.answered'] },
    'POST /api/tasks/:id/approvers': { events: ['task.updated'] },
    'POST /api/tasks/:id/blocks': { events: ['task.block.added'] },
    'DELETE /api/tasks/:id/blocks/:blockId': { events: ['task.block.removed'] },
    'POST /api/tasks/:id/attachments': { events: ['task.attachment.added'] },
    'DELETE /api/tasks/:id/attachments/:attachmentId': { events: ['task.attachment.removed'] },
    'POST /api/tasks/:id/relations': { events: ['task.relation.added'] },
    'POST /api/tasks/:id/chat': { events: ['task.comment.created'] },

    // ── Task chat (`api/task-chat-messages`) ─────────────────────────────────
    'PATCH /api/task-chat-messages/:id': { events: ['task.comment.updated'] },

    // ── Task templates (`api/task-templates`) ────────────────────────────────
    'POST /api/task-templates': {
        exempt: 'A template is not a task; nothing an integration syncs changes.',
    },
    'PATCH /api/task-templates/:id': {
        exempt: 'A template is not a task; nothing an integration syncs changes.',
    },
    'DELETE /api/task-templates/:id': {
        exempt: 'A template is not a task; nothing an integration syncs changes.',
    },
    'POST /api/task-templates/:id/instantiate': { events: ['task.created'] },
    // ── Teams (`api/organizations/:orgId`) ───────────────────────────────────
    'POST /api/organizations/:orgId/teams': { events: ['team.created'] },
    'PATCH /api/organizations/:orgId/teams/:teamId': { events: ['team.updated'] },
    'DELETE /api/organizations/:orgId/teams/:teamId': {
        // + child teams re-parented, agents / tasks / works losing the team from `teamIds`.
        events: [
            'team.deleted',
            'team.updated',
            'agent.updated',
            'task.updated',
            'work.updated',
            'idea.updated',
            'goal.updated',
            'mission.updated',
        ],
    },
    'POST /api/organizations/:orgId/teams/:teamId/members': {
        events: ['team.member.added', 'agent.updated'],
    },
    'DELETE /api/organizations/:orgId/teams/:teamId/members/:memberId': {
        events: ['team.member.removed', 'agent.updated'],
    },
    'POST /api/organizations/:orgId/teams/:teamId/resources': {
        events: [
            'team.resource.added',
            'task.updated',
            'work.updated',
            'idea.updated',
            'goal.updated',
            'mission.updated',
        ],
    },
    'DELETE /api/organizations/:orgId/teams/:teamId/resources/:resourceType/:resourceId': {
        events: [
            'team.resource.removed',
            'task.updated',
            'work.updated',
            'idea.updated',
            'goal.updated',
            'mission.updated',
        ],
    },

    // ── Organization roster (`api/organizations/:orgId`, `api/org-invite`) ──
    'POST /api/organizations/:orgId/invitations': { events: ['organization.member.added'] },
    'DELETE /api/organizations/:orgId/invitations/:invitationId': {
        exempt: 'Revokes a pending invitation; the roster (organization_members) does not change.',
    },
    'DELETE /api/organizations/:orgId/members/:userId': { events: ['organization.member.removed'] },
    // EW-P2-6 — admin / member.
    'PATCH /api/organizations/:orgId/members/:userId': { events: ['organization.member.updated'] },
    'POST /api/org-invite/preview': {
        exempt: 'Read-only preview of an invitation token (POST only to keep the token out of URLs).',
    },
    'POST /api/org-invite/accept': { events: ['organization.member.added'] },

    // ── Organizations (`api/organizations`) ──────────────────────────────────
    // EW-P2-6 — `organization.created` (catalog v1-draft.8).
    'POST /api/organizations': { events: ['organization.created'] },
    'POST /api/organizations/register-company': {
        events: ['work.created', 'organization.created'],
    },
    'PATCH /api/organizations/:id': { events: ['organization.updated'] },
    'POST /api/organizations/:id/upgrade-from-account': {
        exempt: 'Bulk move of a personal account into a NEW organization (scope backfill); no v1 type covers organization creation (P2).',
    },

    // ── Agents (`api/agents`) ────────────────────────────────────────────────
    'POST /api/agents': { events: ['agent.created'] },
    'POST /api/agents/from-template/:slug': { events: ['agent.created'] },
    'PATCH /api/agents/:id': { events: ['agent.updated'] },
    'POST /api/agents/:id/targets': {
        exempt: 'Reach targets (agent_memberships) are not part of the agent integration DTO.',
    },
    'DELETE /api/agents/:id/targets/:targetType/:targetId': {
        exempt: 'Reach targets (agent_memberships) are not part of the agent integration DTO.',
    },
    'PUT /api/agents/:id/guardrails': {
        exempt: 'Guardrails are not part of the agent integration DTO.',
    },
    'DELETE /api/agents/:id': { events: ['agent.archived', 'agent.deleted'] },
    'POST /api/agents/:id/pause': { events: ['agent.status_changed'] },
    'POST /api/agents/:id/resume': { events: ['agent.status_changed'] },
    'POST /api/agents/:id/heartbeat/pause': {
        exempt: 'The heartbeat schedule is not part of the agent integration DTO.',
    },
    'POST /api/agents/:id/heartbeat/resume': {
        exempt: 'The heartbeat schedule is not part of the agent integration DTO.',
    },
    'POST /api/agents/:id/unarchive': { events: ['agent.status_changed'] },
    'PUT /api/agents/:id/files/:name': {
        exempt: "The agent's markdown files (soul, tools, heartbeat) are not part of the agent integration DTO.",
    },
    'POST /api/agents/import': {
        exempt: 'Agent bundle import (AgentExportService) records no event yet: follow-up — imported agents surface through the integration reconcile (updatedSince).',
    },
    'POST /api/agents/:id/run-now': {
        exempt: 'Starts a run (agent_runs); run state is runtime, not the agent DTO.',
    },
    'POST /api/agents/:id/runs/:runId/cancel': {
        exempt: 'Writes agent_runs (runtime), not the agent aggregate.',
    },
    'POST /api/agents/:id/runs/:runId/steer': {
        exempt: 'Writes agent_runs (runtime), not the agent aggregate.',
    },
    'POST /api/agents/:id/runs/:runId/interrupt': {
        exempt: 'Writes agent_runs (runtime), not the agent aggregate.',
    },
    'POST /api/agents/:id/runs/:runId/resume': {
        exempt: 'Writes agent_runs (runtime), not the agent aggregate.',
    },
    'POST /api/agents/:id/assign-task': {
        exempt: 'Queues an agent run for a task (agent_runs); the task records task.runtime_updated when the run is dispatched.',
    },
    'POST /api/agents/:id/attachments': {
        exempt: 'Agent attachments are not part of the agent integration DTO.',
    },
    'DELETE /api/agents/:id/attachments/:attachmentId': {
        exempt: 'Agent attachments are not part of the agent integration DTO.',
    },
    'PUT /api/agents/:id/collaborators/:collaboratorAgentId': {
        exempt: 'Agent collaborators are not part of the agent integration DTO.',
    },
    'DELETE /api/agents/:id/collaborators/:collaboratorAgentId': {
        exempt: 'Agent collaborators are not part of the agent integration DTO.',
    },

    // ── Work members (`api/works/:workId/members`) ───────────────────────────
    'POST /api/works/:workId/members': { events: ['work.member.added'] },
    'PUT /api/works/:workId/members/:memberId': { events: ['work.member.updated'] },
    'DELETE /api/works/:workId/members/:memberId': { events: ['work.member.removed'] },
    'POST /api/works/:workId/members/leave': { events: ['work.member.removed'] },

    // ── Knowledge Base (`api/works/:id/kb`, `api/organizations/:orgId/kb`,
    //    `api/knowledge`, `api/memory`, EW-P3-2) ──────────────────────────────
    'POST /api/works/:id/kb/documents': { events: ['kb.document.created'] },
    'PATCH /api/works/:id/kb/documents/:docId': { events: ['kb.document.updated'] },
    'DELETE /api/works/:id/kb/documents/:docId': { events: ['kb.document.deleted'] },
    'POST /api/works/:id/kb/documents/:docId/lock': { events: ['kb.document.updated'] },
    'POST /api/works/:id/kb/documents/:docId/unlock': { events: ['kb.document.updated'] },
    'POST /api/works/:id/kb/documents/:docId/restore': { events: ['kb.document.updated'] },
    // Accepting a proposed decision is also the review; a supersede updates the survivor.
    'POST /api/works/:id/kb/documents/:docId/decision-status': {
        events: ['kb.document.updated', 'kb.document.review_changed'],
    },
    'POST /api/works/:id/kb/documents/:docId/accept': { events: ['kb.document.review_changed'] },
    'POST /api/works/:id/kb/documents/:docId/archive': { events: ['kb.document.archived'] },
    'POST /api/works/:id/kb/documents/:docId/unarchive': { events: ['kb.document.unarchived'] },
    'POST /api/works/:id/kb/tags': {
        exempt: 'The tag catalog of a Work; a document records its own tags when it is edited.',
    },
    'PATCH /api/works/:id/kb/tags/:tagId': {
        exempt: 'The tag catalog of a Work; a document records its own tags when it is edited.',
    },
    'DELETE /api/works/:id/kb/tags/:tagId': {
        exempt: 'The tag catalog of a Work; a document records its own tags when it is edited.',
    },
    // The document an upload's extraction files (KnowledgeBaseService.createDocument).
    'POST /api/works/:id/kb/uploads': { events: ['kb.document.created'] },
    'POST /api/works/:id/kb/uploads/:uploadId/retry-extraction': {
        events: ['kb.document.created'],
    },
    'POST /api/organizations/:orgId/kb/documents': { events: ['kb.document.created'] },
    'PATCH /api/knowledge/documents/file': { events: ['kb.document.moved'] },
    'POST /api/knowledge/documents/:docId/archive': { events: ['kb.document.archived'] },
    'POST /api/knowledge/documents/:docId/unarchive': { events: ['kb.document.unarchived'] },
    // Organization library folders record `kb.folder.*`; a person's own Memory folders nothing.
    'POST /api/memory/files/folders': { events: ['kb.folder.created'] },
    'PATCH /api/memory/files/folders/:id': { events: ['kb.folder.updated'] },
    // + `kb.document.moved` for every document the delete unfiles.
    'DELETE /api/memory/files/folders/:id': {
        events: ['kb.folder.deleted', 'kb.document.moved'],
    },
    'POST /api/memory/files/upload': {
        exempt: "A person's own Memory file (user_uploads), not a Knowledge Base document.",
    },
    'POST /api/memory/files/folders/:id/sync': {
        exempt: 'Configures a GitHub sync target of a folder; nothing the KB DTO carries changes.',
    },
    'PATCH /api/memory/files/move': {
        exempt: "Moves a person's own Memory files between folders, not Knowledge Base documents.",
    },
    'DELETE /api/memory/files/:id': {
        exempt: "Deletes a person's own Memory file, not a Knowledge Base document.",
    },
    // The synthesis documents a consolidation run files (createOrgDocument).
    'POST /api/memory/consolidate': { events: ['kb.document.created'] },
    // The organization document an upload's extraction files (createOrgDocument).
    'POST /api/memory/uploads': { events: ['kb.document.created'] },
    'POST /api/memory/uploads/from-attachments': { events: ['kb.document.created'] },
    'PUT /api/memory/consolidation/settings': {
        exempt: 'The consolidation schedule of an organization; no document changes.',
    },
    'POST /api/memory/review/:docId/accept': { events: ['kb.document.review_changed'] },
    'POST /api/memory/review/:docId/reject': { events: ['kb.document.archived'] },

    // ── Ideas (`api/me/work-proposals`, EW-P2-1) ─────────────────────────────
    // Recorded by `WorkProposalRepository`, the write path every Idea change takes.
    'POST /api/me/work-proposals': { events: ['idea.created'] },
    'POST /api/me/work-proposals/refresh': { events: ['idea.created'] },
    'PUT /api/me/work-proposals/preferences': {
        exempt: "The caller's Idea-generation preferences (work_agent_preferences), not an Idea.",
    },
    'PATCH /api/me/work-proposals/:id/dismiss': { events: ['idea.status_changed'] },
    'DELETE /api/me/work-proposals/:id': { events: ['idea.deleted'] },
    'POST /api/me/work-proposals/:id/build': { events: ['idea.status_changed'] },
    'POST /api/me/work-proposals/:id/retry': { events: ['idea.status_changed'] },
    'POST /api/me/work-proposals/:id/rebuild': { events: ['idea.status_changed'] },
    'POST /api/me/work-proposals/:id/accept': { events: ['idea.status_changed'] },
    'POST /api/me/work-proposals/:id/attachments': {
        exempt: 'Idea attachments are not part of the idea integration DTO.',
    },
    'DELETE /api/me/work-proposals/:id/attachments/:attachmentId': {
        exempt: 'Idea attachments are not part of the idea integration DTO.',
    },

    // ── Goals (`api/me/goals`, EW-P2-2) ──────────────────────────────────────
    'POST /api/me/goals': { events: ['goal.created'] },
    // An `outcome` override completes the Goal: `goal.status_changed` instead.
    'PATCH /api/me/goals/:id': { events: ['goal.updated', 'goal.status_changed'] },
    // + `mission.goal.unlinked` for each Mission the Goal was linked to (the cascade).
    'DELETE /api/me/goals/:id': { events: ['goal.deleted', 'mission.goal.unlinked'] },
    'POST /api/me/goals/:id/activate': { events: ['goal.status_changed'] },
    'POST /api/me/goals/:id/pause': { events: ['goal.status_changed'] },
    // The evaluation's auto-outcome, else the throttled progress event.
    'POST /api/me/goals/:id/evaluate-now': {
        events: ['goal.status_changed', 'goal.progress_changed'],
    },
    'PATCH /api/me/goals/:id/limits': {
        exempt: 'Execution-loop limits (spend cap, wall clock, concurrency, model hints): EW-only settings, not in the goal integration DTO.',
    },
    'PUT /api/me/goals/:id/dod': { events: ['goal.updated'] },
    'POST /api/me/goals/:id/dod/propose': { events: ['goal.updated'] },
    'POST /api/me/goals/:id/dod/approve': { events: ['goal.updated'] },
    'PATCH /api/me/goals/:id/dod/:criterionId': { events: ['goal.updated'] },
    'POST /api/me/goals/:id/spend-rollup': {
        exempt: 'Recomputes the loop spend (EW-only runtime, contract A.4): never bumps the goal version.',
    },
    'POST /api/me/goals/:id/loop/start': {
        exempt: 'An execution-loop control (EW-only runtime, contract A.4): loop state never bumps the goal version.',
    },
    'POST /api/me/goals/:id/loop/resume': {
        exempt: 'An execution-loop control (EW-only runtime, contract A.4): loop state never bumps the goal version.',
    },
    'POST /api/me/goals/:id/loop/pause': {
        exempt: 'An execution-loop control (EW-only runtime, contract A.4): loop state never bumps the goal version.',
    },
    'POST /api/me/goals/:id/loop/cancel': {
        exempt: 'An execution-loop control (EW-only runtime, contract A.4): loop state never bumps the goal version.',
    },
    // A restart / advance that ends the loop may complete a delivery Goal.
    'POST /api/me/goals/:id/loop/restart': { events: ['goal.status_changed'] },
    'POST /api/me/goals/:id/advance': { events: ['goal.status_changed'] },
    'POST /api/me/goals/:id/nudge': {
        exempt: 'A steering message into the live iteration run, not a Goal change.',
    },
    'POST /api/me/goals/:id/archive': { events: ['goal.archived'] },
    'POST /api/me/goals/:id/unarchive': { events: ['goal.unarchived'] },

    // ── Missions (`api/me/missions`, EW-P2-5) ────────────────────────────────
    'POST /api/me/missions': { events: ['mission.created'] },
    'PATCH /api/me/missions/:id': { events: ['mission.updated'] },
    // + the cascade's changes: a linked Goal's links, an Idea's `missionId`, a clone's
    // `sourceMissionId`.
    'DELETE /api/me/missions/:id': {
        events: ['mission.deleted', 'goal.updated', 'idea.updated', 'mission.updated'],
    },
    'POST /api/me/missions/:id/pause': { events: ['mission.status_changed'] },
    'POST /api/me/missions/:id/resume': { events: ['mission.status_changed'] },
    'POST /api/me/missions/:id/complete': { events: ['mission.status_changed'] },
    // The clone and the Ideas it copies.
    'POST /api/me/missions/:id/clone': { events: ['mission.created', 'idea.created'] },
    // A tick: generated Ideas, the ones it queues for build, a fatal failure.
    'POST /api/me/missions/:id/run-now': {
        events: ['idea.created', 'idea.status_changed', 'mission.status_changed'],
    },
    'POST /api/me/missions/:id/works': { events: ['mission.work.linked'] },
    'DELETE /api/me/missions/:id/works/:workId/:relation': { events: ['mission.work.unlinked'] },
    'POST /api/me/missions/:id/attachments': {
        exempt: 'Mission attachments (uploads) are not part of the mission integration DTO.',
    },
    'DELETE /api/me/missions/:id/attachments/:attachmentId': {
        exempt: 'Mission attachments (uploads) are not part of the mission integration DTO.',
    },
    // The link (child of the Mission) and the Goal's `missionIds` / `primaryMissionId`.
    'POST /api/me/missions/:id/goals': { events: ['mission.goal.linked', 'goal.updated'] },
    'DELETE /api/me/missions/:id/goals/:goalId': {
        events: ['mission.goal.unlinked', 'goal.updated'],
    },

    // ── Works (`api`) ────────────────────────────────────────────────────────
    'POST /api/works': { events: ['work.created'] },
    'POST /api/works/quick-create': { events: ['work.created'] },
    'PUT /api/works/:id': { events: ['work.updated'] },
    'PATCH /api/works/:id': { events: ['work.updated'] },
    'POST /api/works/:id/delete': { events: ['work.deleted'] },
    'POST /api/works/import': { events: ['work.created'] },
    'POST /api/works/:id/activity-sync/rotate-secret': { exempt: WORK_CONTENT },
    'POST /api/works/:id/import-items/validate': { exempt: WORK_CONTENT },
    'POST /api/works/:id/import-items': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/website-settings': { exempt: WORK_CONTENT },
    'POST /api/works/generate-details': { exempt: WORK_CONTENT },
    'POST /api/works/:id/generate': { exempt: WORK_CONTENT },
    'POST /api/works/:id/update': { exempt: WORK_CONTENT },
    'POST /api/works/:id/cancel-generation': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/schedule': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/schedule': { exempt: WORK_CONTENT },
    'POST /api/works/:id/schedule/run': { exempt: WORK_CONTENT },
    'POST /api/works/:id/submit-item': { exempt: WORK_CONTENT },
    'POST /api/works/:id/remove-item': { exempt: WORK_CONTENT },
    'POST /api/works/:id/update-item': { exempt: WORK_CONTENT },
    'POST /api/works/:id/check-item-health': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/source-validation': { exempt: WORK_CONTENT },
    'POST /api/extract-item-details': { exempt: WORK_CONTENT },
    'POST /api/works/:id/bulk-capture-images': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/domain-type': { exempt: WORK_CONTENT },
    'POST /api/works/:id/regenerate-markdown': { exempt: WORK_CONTENT },
    'POST /api/works/:id/update-readme': { exempt: WORK_CONTENT },
    'POST /api/works/:id/update-website': { exempt: WORK_CONTENT },
    'POST /api/works/:id/switch-website-template': { exempt: WORK_CONTENT },
    'POST /api/works/:id/sync-data': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/repositories/visibility': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/advanced-prompts': { exempt: WORK_CONTENT },
    'POST /api/works/import/analyze': { exempt: WORK_CONTENT },
    'POST /api/works/import/analyze-for-linking': { exempt: WORK_CONTENT },
    'POST /api/works/:id/categories': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/categories/:categoryId': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/categories/:categoryId': { exempt: WORK_CONTENT },
    'POST /api/works/:id/tags': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/tags/:tagId': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/tags/:tagId': { exempt: WORK_CONTENT },
    'POST /api/works/:id/collections': { exempt: WORK_CONTENT },
    'PUT /api/works/:id/collections/:collectionId': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/collections/:collectionId': { exempt: WORK_CONTENT },
    'POST /api/works/:id/process-community-prs': { exempt: WORK_CONTENT },
    'POST /api/works/:id/comparisons/generate': { exempt: WORK_CONTENT },
    'POST /api/works/:id/comparisons/generate-manual': { exempt: WORK_CONTENT },
    'DELETE /api/works/:id/comparisons/:slug': { exempt: WORK_CONTENT },

    // ── Inbox (`api/inbox`, `api/escalations`, `api/agent-approvals`; EW-P3-1) ──
    // + `inbox.item.state_changed` when routing fails after the claim marked the item read.
    'POST /api/inbox/:id/reply': { events: ['inbox.item.answered', 'inbox.item.state_changed'] },
    'PATCH /api/inbox/:id/read': { events: ['inbox.item.state_changed'] },
    'POST /api/inbox/:id/archive': { events: ['inbox.item.state_changed'] },
    'POST /api/inbox/:id/unarchive': { events: ['inbox.item.state_changed'] },
    'DELETE /api/inbox/:id': { events: ['inbox.item.deleted'] },
    // A decision taken through another door closes the Inbox mirror (`escalationResolved` /
    // `proposalDecided`).
    'POST /api/escalations/:id/resolve': { events: ['inbox.item.answered'] },
    'POST /api/agent-approvals/approve-all': { events: ['inbox.item.answered'] },
    'POST /api/agent-approvals/:id/approve': { events: ['inbox.item.answered'] },
    'POST /api/agent-approvals/:id/reject': { events: ['inbox.item.answered'] },
    // Integration API v1 Inbox: the same `InboxService` writes, as the recipient.
    'POST /api/integrations/v1/inbox/items/:id/reply': {
        events: ['inbox.item.answered', 'inbox.item.state_changed'],
    },
    'PATCH /api/integrations/v1/inbox/items/:id/state': { events: ['inbox.item.state_changed'] },
    // Integration API v1 agent email (EW-P4-1): the provider path's dispatcher; + the Task link.
    'POST /api/integrations/v1/email/inbound': {
        events: ['email.message.received', 'email.message.status_changed'],
    },

    // ── Integration API v1 (`api/integrations/v1`, EW-P1-4) ───────────────────
    'POST /api/integrations/v1/tasks': {
        // + extra teamIds as team resources, assignees as edges, a hand-picked visibility.
        events: [
            'task.created',
            'team.resource.added',
            'task.updated',
            'task.assignee.added',
            'task.visibility_changed',
        ],
    },
    'PATCH /api/integrations/v1/tasks/:id': {
        events: [
            'task.updated',
            'team.resource.added',
            'team.resource.removed',
            'task.visibility_changed',
        ],
    },
    'DELETE /api/integrations/v1/tasks/:id': { events: ['task.deleted'] },
    // One `task.transitioned` per hop of the sync walk (EW-P1-6).
    'POST /api/integrations/v1/tasks/:id/transition': { events: ['task.transitioned'] },
    'PUT /api/integrations/v1/tasks/:id/assignees': {
        events: ['task.assignee.added', 'task.assignee.removed'],
    },
    'PUT /api/integrations/v1/tasks/:id/watchers': {
        events: ['task.watcher.added', 'task.watcher.removed'],
    },
    'PUT /api/integrations/v1/tasks/:id/blocks': {
        events: ['task.block.added', 'task.block.removed'],
    },
    'PUT /api/integrations/v1/tasks/:id/relations': {
        events: ['task.relation.added', 'task.relation.removed'],
    },
    // + `task.comment.deleted` when a concurrent create won the externalRef.
    'POST /api/integrations/v1/tasks/:id/comments': {
        events: ['task.comment.created', 'task.comment.deleted'],
    },
    'PATCH /api/integrations/v1/tasks/:id/comments/:cid': { events: ['task.comment.updated'] },
    'DELETE /api/integrations/v1/tasks/:id/comments/:cid': { events: ['task.comment.deleted'] },
    // + `team.deleted` when a concurrent create won the externalRef.
    'POST /api/integrations/v1/teams': { events: ['team.created', 'team.deleted'] },
    'PATCH /api/integrations/v1/teams/:id': { events: ['team.updated'] },
    // As the app's DELETE: the cascade re-records children, members and resources.
    'DELETE /api/integrations/v1/teams/:id': {
        events: [
            'team.deleted',
            'team.updated',
            'agent.updated',
            'task.updated',
            'work.updated',
            'idea.updated',
            'goal.updated',
            'mission.updated',
        ],
    },
    'PUT /api/integrations/v1/teams/:id/members': {
        events: ['team.member.added', 'team.member.removed', 'agent.updated'],
    },
    'PUT /api/integrations/v1/teams/:id/resources': {
        events: [
            'team.resource.added',
            'team.resource.removed',
            'task.updated',
            'work.updated',
            'idea.updated',
            'goal.updated',
            'mission.updated',
        ],
    },

    // ── Integration API v1 — Ideas (EW-P2-1) ──────────────────────────────────
    // + `idea.deleted` when a concurrent create won the externalRef (ours is undone).
    'POST /api/integrations/v1/ideas': { events: ['idea.created', 'idea.deleted'] },
    // Title / description `idea.updated`; `teamIds` an `idea.updated` or, when the
    // scope moves (D11), `idea.visibility_changed`; a hand-picked visibility too.
    'PATCH /api/integrations/v1/ideas/:id': {
        events: ['idea.updated', 'idea.visibility_changed'],
    },
    'POST /api/integrations/v1/ideas/:id/dismiss': { events: ['idea.status_changed'] },
    'POST /api/integrations/v1/ideas/:id/restore': { events: ['idea.status_changed'] },

    // ── Integration API v1 — Goals (EW-P2-2) ──────────────────────────────────
    // + `goal.deleted` when a concurrent create won the externalRef (ours is undone).
    'POST /api/integrations/v1/goals': { events: ['goal.created', 'goal.deleted'] },
    'PATCH /api/integrations/v1/goals/:id': {
        events: ['goal.updated', 'goal.visibility_changed'],
    },
    'PUT /api/integrations/v1/goals/:id/criteria': { events: ['goal.updated'] },
    'PUT /api/integrations/v1/goals/:id/dod': { events: ['goal.updated'] },
    'POST /api/integrations/v1/goals/:id/samples': { events: ['goal.progress_changed'] },
    'DELETE /api/integrations/v1/goals/:id': { events: ['goal.deleted', 'mission.goal.unlinked'] },

    // ── Integration API v1 — Missions (EW-P2-5) ───────────────────────────────
    // + `mission.deleted` when a concurrent create won the externalRef (ours is undone).
    'POST /api/integrations/v1/missions': { events: ['mission.created', 'mission.deleted'] },
    'PATCH /api/integrations/v1/missions/:id': {
        events: ['mission.updated', 'mission.visibility_changed', 'mission.status_changed'],
    },
    'PUT /api/integrations/v1/missions/:id/goals': {
        events: ['mission.goal.linked', 'mission.goal.unlinked', 'goal.updated'],
    },
    'PUT /api/integrations/v1/missions/:id/works': {
        events: ['mission.work.linked', 'mission.work.unlinked'],
    },
    // + the cascade's changes: a linked Goal's links, an Idea's `missionId`, a clone's
    // `sourceMissionId`.
    'DELETE /api/integrations/v1/missions/:id': {
        events: ['mission.deleted', 'goal.updated', 'idea.updated', 'mission.updated'],
    },

    // ── Integration API v1 — Organizations (EW-P2-6, `org:write`) ─────────────
    // + `organization.member.added` when an admin's key adds its creator as admin.
    'POST /api/integrations/v1/organizations': {
        events: ['organization.created', 'organization.member.added'],
    },
    // Gauzy CR-6 — a Project Work, plus its Teams (`team_resources` type `work`).
    'POST /api/integrations/v1/works': {
        events: ['work.created', 'team.resource.added', 'work.updated'],
    },
    // Integration API v1 Knowledge Base (EW-P3-2): the same services as the app's routes.
    // + `kb.document.moved` when the create files the document into a folder.
    'POST /api/integrations/v1/kb/documents': {
        events: ['kb.document.created', 'kb.document.moved'],
    },
    'PATCH /api/integrations/v1/kb/documents/:id': { events: ['kb.document.updated'] },
    'DELETE /api/integrations/v1/kb/documents/:id': { events: ['kb.document.deleted'] },
    'POST /api/integrations/v1/kb/documents/:id/accept': {
        events: ['kb.document.review_changed'],
    },
    'POST /api/integrations/v1/kb/documents/:id/archive': { events: ['kb.document.archived'] },
    'POST /api/integrations/v1/kb/documents/:id/unarchive': {
        events: ['kb.document.unarchived'],
    },
    'POST /api/integrations/v1/kb/documents/:id/move': { events: ['kb.document.moved'] },
    'POST /api/integrations/v1/kb/folders': { events: ['kb.folder.created'] },
    'PATCH /api/integrations/v1/kb/folders/:id': { events: ['kb.folder.updated'] },
    'DELETE /api/integrations/v1/kb/folders/:id': {
        events: ['kb.folder.deleted', 'kb.document.moved'],
    },
};

/** The routes a list of events covers (for messages). */
export function describeCoverage(coverage: RouteCoverage): string {
    return 'events' in coverage ? coverage.events.join(', ') : `exempt: ${coverage.exempt}`;
}
