import { DataSource } from 'typeorm';
import {
    WorkProposal,
    WorkProposalSource,
    WorkProposalStatus,
} from '../../entities/work-proposal.entity';
import { User } from '../../entities/user.entity';
import { Work } from '../../entities/work.entity';
import { WorkAdvancedPrompts } from '../../entities/work-advanced-prompts.entity';
import { WorkCodeUpdate } from '../../entities/work-code-update.entity';
import { WorkCustomDomain } from '../../entities/work-custom-domain.entity';
import { WorkDeployment } from '../../entities/work-deployment.entity';
import { WorkMember } from '../../entities/work-member.entity';
import { WorkInvitation } from '../../entities/work-invitation.entity';
import { WorkGenerationHistory } from '../../entities/work-generation-history.entity';
import { WorkSchedule } from '../../entities/work-schedule.entity';
import { UserSubscription } from '../../entities/user-subscription.entity';
import { SubscriptionPlan } from '../../entities/subscription-plan.entity';
import { UsageLedgerEntry } from '../../entities/usage-ledger-entry.entity';

describe('WorkProposal entity', () => {
    let dataSource: DataSource;

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [
                WorkProposal,
                User,
                Work,
                WorkAdvancedPrompts,
                WorkCodeUpdate,
                WorkCustomDomain,
                WorkDeployment,
                WorkMember,
                WorkInvitation,
                WorkGenerationHistory,
                WorkSchedule,
                UserSubscription,
                SubscriptionPlan,
                UsageLedgerEntry,
            ],
            synchronize: true,
        });
        await dataSource.initialize();
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    it('synchronizes on better-sqlite3 (no Object-type columns)', async () => {
        const table = await dataSource.query(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='work_proposals'",
        );
        expect(table).toHaveLength(1);
    });

    it('round-trips a proposal with enum status/source and JSON columns', async () => {
        const userRepo = dataSource.getRepository(User);
        const user = await userRepo.save(
            userRepo.create({
                username: 'ada',
                email: 'ada@example.com',
                password: 'x',
                userResearchOptOut: false,
            }),
        );

        const repo = dataSource.getRepository(WorkProposal);
        const created = await repo.save(
            repo.create({
                userId: user.id,
                title: 'AI Agent Frameworks',
                description: 'Curated list of frameworks.',
                slugSuggestion: 'ai-agent-frameworks',
                suggestedCategories: [{ name: 'OSS', slug: 'oss' }],
                suggestedFields: [{ name: 'github_url', type: 'url' }],
                recommendedPlugins: [{ pluginId: 'tavily', reason: 'search' }],
                reasoning: 'matches profile',
                source: WorkProposalSource.AUTO_SIGNUP,
                status: WorkProposalStatus.PENDING,
            }),
        );

        const found = await repo.findOneByOrFail({ id: created.id });
        expect(found.status).toBe(WorkProposalStatus.PENDING);
        expect(found.source).toBe(WorkProposalSource.AUTO_SIGNUP);
        expect(found.suggestedCategories).toEqual([{ name: 'OSS', slug: 'oss' }]);
    });
});
