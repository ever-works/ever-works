/**
 * APW-01 FR-55 → APW-07 — the adapter that binds `APP_PROMPTED_VALUES_PORT`.
 *
 * ## Why it exists (live e2e on prod, 2026-10-18)
 *
 * `POST /api/works {kind:"app", appEnv:{…}}` logged
 * `App Work create: no prompted-values port is bound, so 2 provided value(s) … were dropped.`
 * The port had been left unbound on purpose because `AppEnvService.apply` needs
 * an actor and a spec that declares the names, and the port's call carries
 * neither. Both gaps are closed here rather than by inventing either:
 *
 *   - **The actor** is the member who created the Work — the create path now
 *     passes its `userId` (the port's optional third argument), and an older
 *     caller that does not is answered from the Work row's owner, which at
 *     creation time is the same person.
 *   - **The spec** does not exist yet at create time (a Link waits for its setup
 *     pull request, a fork for its readiness run), so the values are applied
 *     with `allowWithoutSpec`: against an empty spec, every name undeclared,
 *     stored encrypted with origin `prompted`. The rows are judged by name
 *     against the real spec the moment one is effective.
 *
 * ## Where it is bound, and why through `ModuleRef`
 *
 * The consumer, `AppWorkCreateService`, is declared in the agent
 * `AppWorksModule`, so the token has to be bound THERE (a provider declared in a
 * module that imports it is invisible — the C10 rule that module documents).
 * Importing `AppEnvModule` into it would drag `TypeOrmModule.forFeature` into the
 * bare-graph compiles its specs perform, so the adapter resolves
 * `AppEnvService` and `WorkRepository` lazily (`strict: false`) at call time —
 * the shape `AppLicenseService` and `AppEnvModule`'s own spec source use. In the
 * API both are in the graph (`AppRuntimeEnvModule` → `AppEnvModule`;
 * `DatabaseModule`). A process without them (the CLI, a lean worker) drops the
 * values and says so, exactly as the unbound port did.
 *
 * ## Secrets (Constitution VII)
 *
 * Values are never logged: not on success, not on a refusal. A refusal is
 * reported by NAME and code only.
 */
import { Logger } from '@nestjs/common';
import type { AppPromptedValuesPort } from '../app-works/app-prompted-values.port';
import type { WorkRepository } from '../database/repositories/work.repository';
import type { AppEnvService } from './app-env.service';

/**
 * The two collaborators, each resolved lazily over the running graph (`undefined`
 * when the graph has none). Passed in — rather than imported as values here — so this
 * file stays free of the env service's and the repository's import graphs and the
 * binding module decides how they are found.
 */
export interface AppEnvPromptedValuesLookups {
    readonly env: () => AppEnvService | undefined;
    readonly works: () => WorkRepository | undefined;
}

export class AppEnvPromptedValuesAdapter implements AppPromptedValuesPort {
    private readonly logger = new Logger(AppEnvPromptedValuesAdapter.name);

    constructor(private readonly lookups: AppEnvPromptedValuesLookups) {}

    async storePrompted(
        workId: string,
        values: Record<string, string>,
        context?: { readonly userId?: string | null },
    ): Promise<void> {
        const entries = Object.entries(values ?? {}).filter(
            (entry): entry is [string, string] =>
                typeof entry[0] === 'string' && typeof entry[1] === 'string',
        );
        if (entries.length === 0) {
            return;
        }

        const env = this.lookups.env();
        if (!env || typeof env.apply !== 'function') {
            this.logger.warn(
                `App Work create: no App env service is reachable, so ${entries.length} provided ` +
                    `value(s) for work ${workId} were dropped.`,
            );
            return;
        }

        const userId = await this.actorOf(workId, context);
        if (!userId) {
            this.logger.warn(
                `App Work create: work ${workId} has no resolvable owner, so ${entries.length} provided ` +
                    'value(s) were dropped.',
            );
            return;
        }

        const result = await env.apply(
            workId,
            { userId, canEdit: true },
            { set: entries.map(([name, value]) => ({ name, value })) },
            { allowWithoutSpec: true, origin: 'prompted' },
        );

        const refused = (result?.results ?? []).filter((item) => item.action === 'refused');
        if (result?.reason || refused.length > 0) {
            // Names and codes only — never a value.
            const detail = refused
                .map((item) => `${item.name ?? '?'}:${item.code ?? 'refused'}`)
                .join(', ');
            this.logger.warn(
                `App Work create: ${result?.changed?.length ?? 0} of ${entries.length} provided value(s) ` +
                    `for work ${workId} were stored` +
                    (result?.reason ? ` (${result.reason})` : '') +
                    (detail ? `; refused: ${detail}` : '') +
                    '.',
            );
            return;
        }
        this.logger.log(
            `App Work create: stored ${result?.changed?.length ?? 0} prompted value(s) for work ${workId}.`,
        );
    }

    private async actorOf(
        workId: string,
        context?: { readonly userId?: string | null },
    ): Promise<string | null> {
        const fromContext = typeof context?.userId === 'string' ? context.userId.trim() : '';
        if (fromContext) {
            return fromContext;
        }
        const works = this.lookups.works();
        if (!works || typeof works.findById !== 'function') {
            return null;
        }
        const work = await works.findById(workId);
        const owner = typeof work?.userId === 'string' ? work.userId.trim() : '';
        return owner || null;
    }
}
