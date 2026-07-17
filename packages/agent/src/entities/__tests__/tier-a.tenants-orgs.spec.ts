import { getMetadataArgsStorage } from 'typeorm';
import { Agent } from '../agent.entity';
import { ApiKey } from '../api-key.entity';
import { Conversation } from '../conversation.entity';
import { GitHubAppInstallation } from '../github-app-installation.entity';
import { GitHubAppUserLink } from '../github-app-user-link.entity';
import { Mission } from '../mission.entity';
import { Notification } from '../notification.entity';
import { OnboardingRequest } from '../onboarding-request.entity';
import { Skill } from '../skill.entity';
import { Task } from '../task.entity';
import { Team } from '../team.entity';
import { Template } from '../template.entity';
import { TemplateCustomization } from '../template-customization.entity';
import { UserSubscription } from '../user-subscription.entity';
import { WebhookSubscription } from '../webhook-subscription.entity';
import { Work } from '../work.entity';
import { WorkDeployment } from '../work-deployment.entity';
import { WorkKnowledgeDocument } from '../work-knowledge-document.entity';
import { WorkProposal } from '../work-proposal.entity';
import { WorkSchedule } from '../work-schedule.entity';

/**
 * EW-655 (Tenants & Organizations Phase 3) — Tier A scope-column
 * drift detector.
 *
 * Locks in the per-tier rule from [spec.md §2.3](../../../../../docs/specs/features/tenants-and-organizations/spec.md#23-three-tiers-of-entities-which-columns-each-tier-gets):
 *
 *   - **Every Tier A entity has BOTH `tenantId` and `organizationId`
 *     as nullable uuid columns.** (`organizationId` was already
 *     present on `Work` and `WorkKnowledgeDocument` from earlier
 *     forward-looking work; Phase 3 simply joined the rest of Tier A
 *     to the same shape.)
 *   - Both columns are nullable — service-layer code does NOT start
 *     writing them in Phase 3. The lazy backfill lands in Phase 6.
 *
 * Tier A list is mirrored from `plan.md` Phase 3 and from the
 * migration's `TIER_A_BOTH` + `TIER_A_TENANT_ONLY` arrays. If a new
 * top-level business entity is added in the future, it should be
 * added here too — failing to do so means the new entity ships
 * without scope FKs and silently breaks the multi-Org model.
 */
describe('Tier A entities — Phase 3 scope columns', () => {
    const storage = getMetadataArgsStorage();

    const tierA = [
        { name: 'Mission', target: Mission },
        { name: 'WorkProposal', target: WorkProposal },
        { name: 'Task', target: Task },
        { name: 'Agent', target: Agent },
        { name: 'Skill', target: Skill },
        { name: 'Team', target: Team },
        { name: 'Conversation', target: Conversation },
        { name: 'Notification', target: Notification },
        { name: 'ApiKey', target: ApiKey },
        { name: 'Template', target: Template },
        { name: 'TemplateCustomization', target: TemplateCustomization },
        { name: 'UserSubscription', target: UserSubscription },
        { name: 'WorkSchedule', target: WorkSchedule },
        { name: 'WorkDeployment', target: WorkDeployment },
        { name: 'OnboardingRequest', target: OnboardingRequest },
        { name: 'WebhookSubscription', target: WebhookSubscription },
        { name: 'GitHubAppInstallation', target: GitHubAppInstallation },
        { name: 'GitHubAppUserLink', target: GitHubAppUserLink },
        { name: 'Work', target: Work },
        { name: 'WorkKnowledgeDocument', target: WorkKnowledgeDocument },
    ];

    for (const { name, target } of tierA) {
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
