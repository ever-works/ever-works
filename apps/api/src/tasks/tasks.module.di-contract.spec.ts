import 'reflect-metadata';

/**
 * `@ever-works/agent/services` and `@ever-works/trigger-tasks` both reach
 * the ESM-only `p-map` through the generators barrel, which Jest's CJS
 * transformer cannot load. The controllers drag the whole api service
 * graph. None of the four participates in the question this spec asks, so
 * they are stubbed at module scope — the same posture
 * `workflows.module.spec.ts` and `inbox.module.spec.ts` use.
 *
 * Everything that DOES participate stays real: `TasksDomainModule`,
 * `DatabaseModule`, the agent-side `AgentsModule`, `FleetApiModule` and
 * `ActivityLogModule` are loaded as shipped, so the export metadata this
 * spec walks is the export metadata Nest walks at boot.
 *
 * The one stub that touches the walk is `KnowledgeBaseModule`. Verified by
 * hand: `packages/agent/src/services/knowledge-base.module.ts` exports no
 * skills provider, so replacing it with an empty class cannot mask a
 * reachable token.
 */
jest.mock('@ever-works/agent/services', () => ({
    KnowledgeBaseModule: class KnowledgeBaseModule {},
}));
jest.mock('@ever-works/trigger-tasks', () => ({
    agentTaskExecuteTriggerAdapter: {},
    agentChatReplyTriggerAdapter: {},
}));
jest.mock('./tasks.controller', () => ({ TasksController: class TasksController {} }));
jest.mock('./task-chat.controller', () => ({ TaskChatController: class TaskChatController {} }));

import { PluginSettingsService } from '@ever-works/agent/plugins';
import { SkillsService } from '@ever-works/agent/skills';
import { FleetAgentTaskPlannerService } from '../fleet/fleet-agent-task-planner.service';
import { FleetAgentTaskReconcilerService } from '../fleet/fleet-agent-task-reconciler.service';
import { FleetTaskScopeResolverService } from '../fleet/fleet-task-scope.resolver';
import { TasksModule } from './tasks.module';

/**
 * TasksModule — the fleet providers' dependencies are actually reachable.
 *
 * `FleetAgentTaskPlannerService` is provided HERE, so Nest resolves its
 * constructor against THIS module's imports. Its collaborators are
 * `@Optional()` on purpose: the planner must degrade rather than refuse to
 * construct in a reduced graph. That is a safety net, NOT a licence for the
 * production module to omit a provider — and it is exactly what made the
 * omission invisible.
 *
 * The skills dependency was unreachable from this module: provided and
 * exported only by the agent-side `SkillsModule`, which `AgentsModule`
 * imports (for `AgentRunService`) but never re-exports, and which the
 * @Global() api-side `AgentsModule` does not export either (its export list
 * is tokens only). So `resolveSkills` short-circuited on every call and the
 * fleet system prompt shipped with NO `# ACTIVE SKILLS` segment — on every
 * run, for every agent, with no error and no log. The run still succeeded.
 * The same Task on the cloud path got its skills, because the agent-side
 * `AgentsModule` that provides `AgentRunService` DOES import `SkillsModule`.
 *
 * Nothing else catches this. `fleet-agent-task-planner.spec.ts` hand-provides
 * the collaborator in its testing module, which pins the constructor and says
 * nothing about the real graph; `tsc` is happy because the parameter is
 * optional; boot is happy for the same reason.
 *
 * So this spec asks Nest's own question statically, the way
 * `subscriptions.di-contract.spec.ts` does — with one deliberate difference:
 * that probe SKIPS `@Optional()` parameters, and this one requires them,
 * because an unsatisfied optional is precisely the defect being guarded.
 */
describe('TasksModule — the fleet providers can resolve their dependencies', () => {
    /** `{ provide, useFactory }` entries answer to their token, not the literal. */
    const asToken = (provider: unknown) =>
        provider && typeof provider === 'object' && 'provide' in (provider as object)
            ? (provider as { provide: unknown }).provide
            : provider;

    /**
     * Everything this module can hand to a constructor: its own providers
     * plus whatever each imported module EXPORTS, following a re-exported
     * module one level down (how `DatabaseModule` republishes `TypeOrmModule`).
     */
    const collectExports = (mod: unknown, depth = 0): unknown[] => {
        if (typeof mod !== 'function' || depth > 2) return [];
        const exported = (Reflect.getMetadata('exports', mod) ?? []) as unknown[];
        return exported.flatMap((entry) => {
            const token = asToken(entry);
            const nested =
                typeof token === 'function' && Reflect.getMetadata('exports', token)
                    ? collectExports(token, depth + 1)
                    : [];
            return [token, ...nested];
        });
    };

    const moduleProviders = (Reflect.getMetadata('providers', TasksModule) ?? []) as unknown[];
    const moduleImports = (Reflect.getMetadata('imports', TasksModule) ?? []) as unknown[];
    const resolvable = new Set<unknown>([
        ...moduleProviders.map(asToken),
        ...moduleImports.flatMap((mod) => collectExports(mod)),
    ]);

    /**
     * The one thing this static probe genuinely cannot see, carried over
     * verbatim from `subscriptions.di-contract.spec.ts`: `PluginsModule` is
     * `@Global()` AND dynamic, so its exports are assembled inside
     * `forRoot()` and there is no static `exports` metadata to read. Verified
     * by hand — `packages/agent/src/plugins/plugins.module.ts` carries
     * `@Global()` (:154) and lists `PluginSettingsService` in both its
     * providers (:85) and the private EXPORTS array (:116) that both
     * factories return.
     *
     * Keep this list at one entry. Anything added here is a dependency no
     * test can check.
     */
    const DYNAMIC_GLOBAL_PROVIDERS: unknown[] = [PluginSettingsService];

    /**
     * `design:paramtypes` records `Object` for a parameter whose type is an
     * interface or that is supplied by an `@Inject(TOKEN)`. Nest resolves
     * those by token, never by type, so they are not this probe's business.
     */
    const NOT_A_TYPE_DEPENDENCY = new Set<unknown>([Object, String, Number, Boolean, Array]);

    /**
     * Listed explicitly rather than derived from the providers array, so
     * adding a fleet provider to this module without adding it here is
     * visible in review.
     */
    const SERVICES: Array<[string, new (...args: never[]) => unknown]> = [
        ['FleetAgentTaskPlannerService', FleetAgentTaskPlannerService],
        ['FleetAgentTaskReconcilerService', FleetAgentTaskReconcilerService],
        ['FleetTaskScopeResolverService', FleetTaskScopeResolverService],
    ];

    it('reaches SkillsService, so the fleet prompt can carry ACTIVE SKILLS', () => {
        // The pointed guard. `resolveSkills` returns undefined the moment
        // this is unreachable, and a prompt without skills is a run that
        // ignores the agent's operating rules while reporting success.
        //
        // Specifically `SkillsService` and not `SkillBindingRepository`: the
        // service is the grant-aware resolver (audit item G12), so wiring the
        // raw repository here would fix the missing-skills half of the bug
        // and open a second one — fleet prompts carrying skills the
        // operator's tool-grant matrix denies.
        expect(resolvable.has(SkillsService)).toBe(true);
    });

    it.each(SERVICES)('%s — every class-typed constructor parameter is reachable', (_, Service) => {
        const paramTypes = (Reflect.getMetadata('design:paramtypes', Service) ?? []) as unknown[];
        // `@Inject(TOKEN)` parameters, recorded by index.
        const injected = (Reflect.getMetadata('self:paramtypes', Service) ?? []) as Array<{
            index: number;
        }>;
        const injectedIndexes = new Set(injected.map((entry) => entry.index));

        const unreachable = paramTypes
            .map((type, index) => ({ type, index }))
            .filter(
                ({ type, index }) =>
                    !injectedIndexes.has(index) &&
                    typeof type === 'function' &&
                    !NOT_A_TYPE_DEPENDENCY.has(type) &&
                    !resolvable.has(type) &&
                    !DYNAMIC_GLOBAL_PROVIDERS.includes(type),
            )
            .map(({ type, index }) => `#${index} ${(type as { name: string }).name}`);

        expect(unreachable).toEqual([]);
    });
});
