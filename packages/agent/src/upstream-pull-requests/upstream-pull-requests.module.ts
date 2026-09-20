import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { AppWorksModule } from '../app-works/app-works.module';
import { BudgetsModule } from '../budgets/budgets.module';
import {
    UPSTREAM_CREDENTIAL_STORE,
    UpstreamCredentialService,
} from './upstream-credential.service';
import { UpstreamCredentialStateStore } from './upstream-credential.store';
import { UpstreamContributionBudgetService } from './upstream-contribution-budget.service';

/**
 * APW-09 (Upstream pull requests) — the epic's agent-side module, and the home
 * of T43's **credential of record** (FR-43, XC-18).
 *
 * ## What it provides, and why the binding lives here
 *
 *   - `UpstreamCredentialStateStore` — the durable record a handover writes,
 *     over APW-02's upstream state row;
 *   - `UpstreamCredentialService` — the read, the pause and the handover;
 *   - `UPSTREAM_CREDENTIAL_STORE` — bound to the store.
 *
 * The token was **deliberately unbound** while the record had no home
 * (`upstream-credential.service.ts:134-154`), so a handover refused by name
 * (`handover_unavailable`) rather than writing to memory. It is bound now that
 * `work_upstream_states` carries `credentialMemberUserId` — T43's column, with
 * `apps/api/src/migrations/1792090000000-AddWorkUpstreamCredentialMember.ts` as
 * its migration — and binding it is not "making an unconfigured installation
 * look configured": the store IS the implementation, and its collaborators are
 * what would stay unbound.
 *
 * ## Why this is a module of its own rather than a line in `AppWorksModule`
 *
 * Binding the three entries in APW-02's module was tried first, and the
 * programme's own guard rejected it: `AppWorksModule` is compiled bare by two
 * specs that shell `DatabaseModule` (`app-works.module.spec.ts`,
 * `app-upstream-state.service.spec.ts`) exactly so a collaborator a later
 * service quietly requires fails there instead of at API boot, and
 * `UpstreamCredentialService` injects `WorkRepository` **non-optionally**. The
 * alternative was widening someone else's shell; this module imports
 * `DatabaseModule` for real instead.
 *
 * ## The graph, and the two absences that are not placeholders
 *
 * `AppWorksModule` is imported for `WorkUpstreamStateRepository` — this epic's
 * table is APW-02's, provided and exported there, and re-providing it here would
 * mint a second instance of the same repository. `DatabaseModule` and
 * `FacadesModule` are imported for the collaborators the service reads through
 * (`WorkRepository`, `WorkMemberRepository`, `AuthAccountRepository`,
 * `GitFacadeService`), because a module's providers resolve from the module that
 * declares them or from that module's own imports — and `AppWorksModule`'s
 * `exports` are its own providers, never its imports'. All three imports are
 * leaf imports with respect to this module: none of them imports it, so the
 * graph stays acyclic, and `AppWorksModule` does not import this one at all.
 *
 * Every one of those collaborators is `@Optional()` in the service, so this
 * module still compiles without them — with one exception this module exists to
 * satisfy: `WorkRepository` is **not** optional, which is why the real
 * `DatabaseModule` has to be here rather than behind a shell.
 *
 * ## `useExisting`, not a factory — and why that is safe here
 *
 * A plain alias is a provider cycle only when the aliased provider depends,
 * directly or transitively, on the token being aliased. `UpstreamCredentialStateStore`
 * injects `WorkUpstreamStateRepository` and nothing else: it never injects
 * `UpstreamCredentialService`, so the chain
 * `UPSTREAM_CREDENTIAL_STORE → UpstreamCredentialStateStore → WorkUpstreamStateRepository`
 * terminates, and the only edge back into the token is the service's own
 * `@Optional() @Inject(...)` — the consumer, not a cycle. That is exactly the
 * test the neighbouring `APP_BUILD_PREPARE_RUNNER` binding fails
 * (`app-builds.module.ts:70-77`, where the runner injects the service that
 * injects the token) and the reason that one is a `ModuleRef` factory.
 *
 * ## What is deliberately NOT here
 *
 * The §7 `upstream-pr-*.task.ts` jobs, the poller and the controller T43 also
 * names: they are other tasks' files and do not exist yet. A token whose owner
 * has not landed stays unbound rather than bound to a placeholder — the rule
 * `AppWorksModule`'s docstring states — and the credential of record is
 * complete without them.
 *
 * ## T44's budget gate, and why `BudgetsModule` is imported rather than re-provided
 *
 * `UpstreamContributionBudgetService` (T44, FR-44) injects `BudgetGuardService`
 * and `BudgetService`, both of which `BudgetsModule` provides and exports. They
 * are imported, never re-provided: a second `BudgetGuardService` instance would
 * read the same tables but hold its own alert-state wiring, which is exactly the
 * "two answers to the same question" this module's sibling docstrings refuse.
 * `BudgetsModule` imports `DatabaseModule`, so this adds no new leaf beyond the
 * one already imported here.
 *
 * Both of the service's collaborators are `@Optional()` at the injection site, so
 * this module still compiles in a shell that has not imported `BudgetsModule` —
 * where the gate reports `gate: 'ungated'` rather than pretending a check ran.
 */
@Module({
    imports: [
        // APW-02's table, and the repository this epic's store writes through.
        AppWorksModule,
        // The Work, member and connected-account reads the credential service
        // resolves; the facade module supplies `GitFacadeService` for the FR-24
        // member-token door the background path uses.
        DatabaseModule,
        FacadesModule,
        // T44: the Work budget the contribution-run gate books against.
        BudgetsModule,
    ],
    providers: [
        UpstreamCredentialStateStore,
        UpstreamCredentialService,
        UpstreamContributionBudgetService,
        {
            provide: UPSTREAM_CREDENTIAL_STORE,
            useExisting: UpstreamCredentialStateStore,
        },
    ],
    exports: [
        UpstreamCredentialStateStore,
        UpstreamCredentialService,
        UpstreamContributionBudgetService,
        UPSTREAM_CREDENTIAL_STORE,
    ],
})
export class UpstreamPullRequestsModule {}
