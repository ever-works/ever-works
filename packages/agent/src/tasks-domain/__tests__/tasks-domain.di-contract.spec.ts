import 'reflect-metadata';

import { AppSpecService } from '../../app-spec/app-spec.service';
import { AppWorkChangeGateService } from '../../app-works/app-work-change-gate.service';
import { AppWorkRulesService } from '../../app-works/app-work-rules.service';
import { APP_WORK_CHANGE_GATE } from '../app-work-change-gate.port';
import { TaskWorkspaceService } from '../task-workspace.service';
import { TasksDomainModule } from '../tasks.module';

/**
 * `TasksDomainModule` — the App Works providers can reach what they inject.
 *
 * ## The defect this exists for
 *
 * The first wiring of APW-08's change guard provided `AppWorkRulesService` here
 * and took `AppSpecService` `@Optional()`. `AppSpecModule` is not `@Global()`,
 * and Nest resolves a provider's dependencies from the module that DECLARES it
 * — so in every real graph `specs` was `undefined`, `resolve()` threw on its
 * first line, and the guard refused EVERY App Work finalize. No pull request
 * could ever open for an App Work.
 *
 * Nothing caught it. `tsc` is happy because the parameter is optional; boot is
 * happy for the same reason; and the wiring spec built its collaborators by
 * hand, which pins a constructor and says nothing about the graph. An
 * adversarial review found it by reading the module.
 *
 * ## What this asks
 *
 * Nest's own question, statically, the way `apps/api/src/tasks/
 * tasks.module.di-contract.spec.ts` asks it for the API's module: for each
 * listed provider, is every class-typed constructor parameter provided by this
 * module or EXPORTED by one it imports? `@Optional()` parameters are REQUIRED to
 * be reachable, because an unsatisfied optional is precisely the defect.
 *
 * `@Inject(TOKEN)` parameters are checked by token rather than by type:
 * `design:paramtypes` records `Object` for them.
 */

const asToken = (provider: unknown) =>
    provider && typeof provider === 'object' && 'provide' in (provider as object)
        ? (provider as { provide: unknown }).provide
        : provider;

/** What an imported module hands on: its exports, following re-exported modules down. */
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

const providers = (Reflect.getMetadata('providers', TasksDomainModule) ?? []) as unknown[];
const imports = (Reflect.getMetadata('imports', TasksDomainModule) ?? []) as unknown[];
const resolvable = new Set<unknown>([
    ...providers.map(asToken),
    ...imports.flatMap((mod) => collectExports(mod)),
]);

const NOT_A_TYPE_DEPENDENCY = new Set<unknown>([Object, String, Number, Boolean, Array]);

/** Class-typed parameters not reachable from this module, as `#index Name`. */
function unreachableParams(Service: new (...args: never[]) => unknown): string[] {
    const types = (Reflect.getMetadata('design:paramtypes', Service) ?? []) as unknown[];
    const injected = (Reflect.getMetadata('self:paramtypes', Service) ?? []) as Array<{
        index: number;
    }>;
    const byToken = new Set(injected.map((entry) => entry.index));

    return types
        .map((type, index) => ({ type, index }))
        .filter(
            ({ type, index }) =>
                !byToken.has(index) &&
                typeof type === 'function' &&
                !NOT_A_TYPE_DEPENDENCY.has(type) &&
                !resolvable.has(type),
        )
        .map(({ type, index }) => `#${index} ${(type as { name: string }).name}`);
}

/** `@Inject(TOKEN)` parameters whose token is not reachable. */
function unreachableTokens(Service: new (...args: never[]) => unknown): string[] {
    const injected = (Reflect.getMetadata('self:paramtypes', Service) ?? []) as Array<{
        index: number;
        param: unknown;
    }>;
    return injected
        .filter(({ param }) => typeof param === 'symbol' && !resolvable.has(param))
        .map(({ index, param }) => `#${index} ${String(param)}`);
}

describe('TasksDomainModule — the App Works providers can reach what they inject', () => {
    it('reads real module metadata — a zero here would make every case below vacuous', () => {
        expect(providers.length).toBeGreaterThan(10);
        expect(imports.length).toBeGreaterThan(3);
    });

    it('reaches AppSpecService — the dependency whose absence refused every App Work', () => {
        expect(resolvable.has(AppSpecService)).toBe(true);
    });

    it('AppWorkRulesService — every class-typed parameter is reachable, @Optional included', () => {
        expect(unreachableParams(AppWorkRulesService)).toEqual([]);
    });

    it('AppWorkChangeGateService — every class-typed parameter is reachable', () => {
        expect(unreachableParams(AppWorkChangeGateService)).toEqual([]);
    });

    it('binds APP_WORK_CHANGE_GATE, and TaskWorkspaceService can reach it', () => {
        expect(providers.map(asToken)).toContain(APP_WORK_CHANGE_GATE);
        expect(unreachableTokens(TaskWorkspaceService)).toEqual([]);
    });

    it('exports the gate, so the agent git tools can ask the same one', () => {
        const exported = (Reflect.getMetadata('exports', TasksDomainModule) ?? []) as unknown[];
        expect(exported).toContain(APP_WORK_CHANGE_GATE);
    });

    it('TaskWorkspaceService — every class-typed parameter is reachable', () => {
        // Not only the App Works ones: this is the finalize tail for every
        // Work, and an unreachable `@Optional()` collaborator here degrades
        // silently for all of them.
        expect(unreachableParams(TaskWorkspaceService)).toEqual([]);
    });
});
