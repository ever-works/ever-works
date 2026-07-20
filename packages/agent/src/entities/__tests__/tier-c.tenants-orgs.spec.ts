import { getMetadataArgsStorage } from 'typeorm';
import { ActivityLog } from '../activity-log.entity';
import { AgentBudget } from '../agent-budget.entity';
import { AgentMembership } from '../agent-membership.entity';
import { AgentRun } from '../agent-run.entity';
import { AgentRunLog } from '../agent-run-log.entity';
import { ConversationMessage } from '../conversation-message.entity';
import { PluginUsageEvent } from '../plugin-usage-event.entity';
import { SkillBinding } from '../skill-binding.entity';
import { TaskApprover } from '../task-approver.entity';
import { TaskAssignee } from '../task-assignee.entity';
import { TaskAttachment } from '../task-attachment.entity';
import { TaskBlock } from '../task-block.entity';
import { TaskChatMessage } from '../task-chat-message.entity';
import { TaskKbMention } from '../task-kb-mention.entity';
import { TaskRelation } from '../task-relation.entity';
import { TaskReviewer } from '../task-reviewer.entity';
import { TaskWatcher } from '../task-watcher.entity';
import { TeamMember } from '../team-member.entity';
import { TeamResource } from '../team-resource.entity';
import { UsageLedgerEntry } from '../usage-ledger-entry.entity';
import { WebhookDelivery } from '../webhook-delivery.entity';
import { WorkGenerationHistory } from '../work-generation-history.entity';
import { WorkInvitation } from '../work-invitation.entity';
import { WorkKnowledgeChunk } from '../work-knowledge-chunk.entity';
import { WorkKnowledgeCitation } from '../work-knowledge-citation.entity';
import { WorkKnowledgeTag } from '../work-knowledge-tag.entity';
import { WorkKnowledgeUpload } from '../work-knowledge-upload.entity';
import { WorkMember } from '../work-member.entity';

/**
 * EW-657 (Tenants & Organizations Phase 5a) — Tier C scope-column
 * drift detector.
 *
 * Locks in the per-tier rule from [spec.md §2.3](../../../../../docs/specs/features/tenants-and-organizations/spec.md#23-three-tiers-of-entities-which-columns-each-tier-gets):
 *
 *   - **Every Tier C entity has BOTH `tenantId` and `organizationId`
 *     as nullable uuid columns.** Denormalized copies of the parent
 *     Tier A's scope — see [plan.md Phase 5](../../../../../docs/specs/features/tenants-and-organizations/plan.md#phase-5--tier-c-children-denormalize-tenantid-and-organizationid).
 *   - Both columns are nullable — service-layer code starts writing
 *     them in Phase 5b (ScopeContext provider). Existing rows backfill
 *     lazily on the user's first-Org upgrade (Phase 6).
 *
 * Tier C list is mirrored from `plan.md` Phase 5, `tasks.md` Phase 5,
 * and the migration's `TIER_C_TABLES` array. If a new child entity is
 * added in the future, it should be added here too — failing to do so
 * means the new child ships without scope FKs and silently breaks the
 * multi-Org model.
 *
 * Mirror of [`tier-a.tenants-orgs.spec.ts`](./tier-a.tenants-orgs.spec.ts) and
 * [`tier-b.tenants-orgs.spec.ts`](./tier-b.tenants-orgs.spec.ts).
 */
describe('Tier C entities — Phase 5a scope columns', () => {
    const storage = getMetadataArgsStorage();

    const tierC = [
        { name: 'ConversationMessage', target: ConversationMessage },
        { name: 'TaskAssignee', target: TaskAssignee },
        { name: 'TaskApprover', target: TaskApprover },
        { name: 'TaskReviewer', target: TaskReviewer },
        { name: 'TaskWatcher', target: TaskWatcher },
        { name: 'TaskBlock', target: TaskBlock },
        { name: 'TaskChatMessage', target: TaskChatMessage },
        { name: 'TaskKbMention', target: TaskKbMention },
        { name: 'TaskAttachment', target: TaskAttachment },
        { name: 'TaskRelation', target: TaskRelation },
        { name: 'AgentRun', target: AgentRun },
        { name: 'AgentRunLog', target: AgentRunLog },
        { name: 'AgentBudget', target: AgentBudget },
        { name: 'AgentMembership', target: AgentMembership },
        { name: 'SkillBinding', target: SkillBinding },
        { name: 'TeamMember', target: TeamMember },
        { name: 'TeamResource', target: TeamResource },
        { name: 'WorkMember', target: WorkMember },
        { name: 'WorkInvitation', target: WorkInvitation },
        { name: 'WorkGenerationHistory', target: WorkGenerationHistory },
        { name: 'WorkKnowledgeChunk', target: WorkKnowledgeChunk },
        { name: 'WorkKnowledgeCitation', target: WorkKnowledgeCitation },
        { name: 'WorkKnowledgeTag', target: WorkKnowledgeTag },
        { name: 'WorkKnowledgeUpload', target: WorkKnowledgeUpload },
        { name: 'WebhookDelivery', target: WebhookDelivery },
        { name: 'UsageLedgerEntry', target: UsageLedgerEntry },
        { name: 'PluginUsageEvent', target: PluginUsageEvent },
        { name: 'ActivityLog', target: ActivityLog },
    ];

    for (const { name, target } of tierC) {
        describe(name, () => {
            const columns = storage.columns.filter((c) => c.target === target);

            it('declares a nullable `tenantId` uuid column', () => {
                const col = columns.find((c) => c.propertyName === 'tenantId');
                expect(col).toBeDefined();
                expect(col?.options.type).toBe('uuid');
                expect(col?.options.nullable).toBe(true);
            });

            it('declares a nullable `organizationId` uuid column', () => {
                const col = columns.find((c) => c.propertyName === 'organizationId');
                expect(col).toBeDefined();
                expect(col?.options.type).toBe('uuid');
                expect(col?.options.nullable).toBe(true);
            });
        });
    }
});
