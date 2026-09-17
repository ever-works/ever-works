import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ENTITIES } from '@src/database/database.config';
import { PluginRegistryService } from '@src/plugins/services/plugin-registry.service';
import { PluginSettingsService } from '@src/plugins/services/plugin-settings.service';
import { PluginUsageService } from '@src/usage/plugin-usage.service';
import { BudgetGuardService } from '@src/budgets/budget-guard.service';
import { WorkPluginRepository } from '@src/plugins/repositories/work-plugin.repository';
import { WorkCustomDomainRepository } from '@src/database/repositories/work-custom-domain.repository';
import { EverWorksK8sDeployProvider } from '@src/ever-works-providers/ever-works-k8s-deploy.provider';
import { WorkRepository } from '@src/database/repositories/work.repository';
import { AgentRepository } from '@src/database/repositories/agent.repository';
import { AgentRunRepository } from '@src/database/repositories/agent-run.repository';
import { TaskAgentReviewRepository } from '@src/database/repositories/task-agent-review.repository';
import {
    TaskApproverRepository,
    TaskAssigneeRepository,
} from '@src/database/repositories/task-side.repositories';
import { GitFacadeService } from '@src/facades/git.facade';
import { TasksDomainModule } from '../tasks.module';
import { TaskAgentReviewService } from '../task-agent-review.service';
import { TaskTransitionService } from '../task-transition.service';
import { TaskPrStatusService } from '../task-pr-status.service';
import { TaskCiAutoResumeService } from '../task-ci-auto-resume.service';

/**
 * Reviewer agent stage (slice AD, EW-811) — the REAL `TasksDomainModule`,
 * compiled in a REAL Nest container.
 *
 * ## Why this exists
 *
 * The slice's other wiring spec compiles a synthetic ledger module, so it
 * could only ever prove the ledger. Review found — by deleting
 * `TaskAgentReviewService` from this module's `providers` and `exports` —
 * that every spec stayed green, while in production:
 *
 *  1. the `in_review` hook went silently inert, because
 *     `TaskTransitionService` injects the review service `@Optional()`;
 *  2. the API refused to boot, because the api-side `AgentsModule`
 *     injects it WITHOUT `@Optional()` for `submitTaskReview` — and that
 *     module's own spec mocks `@ever-works/agent/tasks-domain` away.
 *
 * Every collaborator of the review service is `@Optional()`, so a module
 * graph that stops reaching one (the run repository, the git facade …)
 * compiles cleanly and then refuses every review as `reviewer-unreadable`
 * or `pr-unreadable`. So this spec does not stop at "it compiled": it
 * asserts each optional collaborator actually RESOLVED, to the instance the
 * module graph provides.
 *
 * The app-root stubs are the same ones `release-promotion.module.spec.ts`
 * uses: providers the API supplies from its ROOT module, which nothing
 * under test calls.
 *
 * MUTATION CHECK, executed rather than assumed: deleting
 * `TaskAgentReviewService` from `TasksDomainModule.providers` fails the
 * first case ("Nest could not find TaskAgentReviewService element"), and
 * the hook assertion fails if the transition service's injection is lost.
 */

const APP_ROOT_PROVIDERS = [
    PluginRegistryService,
    PluginSettingsService,
    PluginUsageService,
    BudgetGuardService,
    WorkPluginRepository,
    WorkCustomDomainRepository,
    EverWorksK8sDeployProvider,
];

@Global()
@Module({
    providers: APP_ROOT_PROVIDERS.map((token) => ({ provide: token, useValue: {} })),
    exports: APP_ROOT_PROVIDERS,
})
class AppRootStubModule {}

describe('TasksDomainModule — the reviewer agent stage is wired', () => {
    async function compile() {
        return Test.createTestingModule({
            imports: [
                AppRootStubModule,
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                }),
                TasksDomainModule,
            ],
        }).compile();
    }

    it('provides AND exports the review service from the real module', async () => {
        const moduleRef = await compile();
        const reviews = moduleRef.get(TaskAgentReviewService);
        expect(reviews).toBeInstanceOf(TaskAgentReviewService);
        // Exported: the api-side AgentsModule injects it for the verdict
        // tool, from outside this module.
        const exported: unknown[] = Reflect.getMetadata('exports', TasksDomainModule) ?? [];
        expect(exported).toContain(TaskAgentReviewService);
        expect(exported).toContain(TaskAgentReviewRepository);
        await moduleRef.close();
    });

    it('resolves EVERY @Optional() collaborator — none silently undefined', async () => {
        const moduleRef = await compile();
        const reviews = moduleRef.get(TaskAgentReviewService) as unknown as Record<string, unknown>;
        // Checked by CLASS, not by `toBe` against `moduleRef.get(…, { strict:
        // false })`: several of these repositories are provided by more than
        // one module in the graph, so a non-strict lookup may legitimately
        // return a sibling instance — and on a mismatch jest's diff walks the
        // TypeORM repository's getters, which throw (`MongoEntityManager is
        // only available for MongoDB databases`) and hide the real message.
        // What this case exists to prove is that each collaborator RESOLVED
        // to the right kind of thing, never `undefined`.
        const expected: Array<[string, new (...args: never[]) => unknown]> = [
            ['reviews', TaskAgentReviewRepository],
            ['works', WorkRepository],
            ['assignees', TaskAssigneeRepository],
            ['runs', AgentRunRepository],
            ['agents', AgentRepository],
            ['gitFacade', GitFacadeService],
        ];
        for (const [key, type] of expected) {
            expect({ key, resolved: reviews[key] instanceof type }).toEqual({
                key,
                resolved: true,
            });
        }
        expect(reviews.reviews).toBe(moduleRef.get(TaskAgentReviewRepository));
        await moduleRef.close();
    });

    it('hands the review service to the transition hook, and the transition service to the PR poll', async () => {
        const moduleRef = await compile();
        const transitions = moduleRef.get(TaskTransitionService) as unknown as Record<
            string,
            unknown
        >;
        // The ONE automatic trigger on entry to in_review.
        expect(transitions.agentReviews).toBe(moduleRef.get(TaskAgentReviewService));
        // The poll's head-change re-plan reaches reviews through this.
        const prStatus = moduleRef.get(TaskPrStatusService) as unknown as Record<string, unknown>;
        expect(prStatus.transitions).toBe(moduleRef.get(TaskTransitionService));
        await moduleRef.close();
    });

    it('hands CI auto-resume the approver + assignee repositories it skips reviewer agents with', async () => {
        // Review of slice AD: CI feedback was handed to the Task's newest
        // run even when that run was a REVIEWER agent's chat reply. The fix
        // reads who reviews (agent approvers) and who implements (the
        // dispatch ladder), and both collaborators are `@Optional()` — so a
        // module graph that stopped reaching them would compile, quietly
        // skip only review-scoped runs, and resume the reviewer again.
        const moduleRef = await compile();
        const autoResume = moduleRef.get(TaskCiAutoResumeService) as unknown as Record<
            string,
            unknown
        >;
        expect({ approvers: autoResume.approvers instanceof TaskApproverRepository }).toEqual({
            approvers: true,
        });
        expect({ assignees: autoResume.assignees instanceof TaskAssigneeRepository }).toEqual({
            assignees: true,
        });
        await moduleRef.close();
    });

    it('registers the ledger entity, so the first real query does not throw', async () => {
        const moduleRef = await compile();
        const ledger = moduleRef.get(TaskAgentReviewRepository);
        await expect(ledger.countForTask('task-1')).resolves.toBe(0);
        await expect(ledger.listClaimKeysForTask('task-1')).resolves.toEqual([]);
        await expect(ledger.findOpenForRun('run-1')).resolves.toBeNull();
        await moduleRef.close();
    });
});
