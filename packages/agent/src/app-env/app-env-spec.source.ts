import { isUsableAppSpecStatus, type AppSpecService } from '../app-spec/app-spec.service';
import type { AppEnvSpecSnapshot, AppEnvSpecSource } from './app-env.service';

/**
 * APW-07 — `APP_ENV_SPEC_SOURCE` over APW-03's `AppSpecService`.
 *
 * This is the seam the whole epic reads through, and its own docstring says
 * what unbound meant: *"no entries at all"*. `AppEnvService.list` answered `[]`
 * for every App Work, `missingRequired` found nothing to be missing,
 * `ensureGenerated` had no generated entries to create, and `AppEnvResolver`
 * resolved against a spec it never had. Putting `AppEnvModule` in a DI graph
 * this morning wired all of that up to a source that answered nothing.
 *
 * ## The claim this replaces
 *
 * `app-env.service.ts:224` said *"`AppSpecService.getEffectiveSpec(workId,
 * commitSha?)` does not exist in this tree"*. It does, at
 * `app-spec.service.ts:940`, and it has since APW-03 T12 landed. The comment
 * is corrected where it stands rather than only here.
 *
 * ## One departure from the adapter that comment specifies, and why
 *
 * It asks for `{ status: 'valid' }` to map to a snapshot and *"every other
 * status to `null` (fail closed)"*. Taken literally that drops
 * `valid_with_warnings`, and the consequence is not conservative: an App Work
 * whose spec has a single cosmetic warning would lose **every env value it
 * has** — the table renders empty, `missingRequired` reports nothing, and a
 * Deploy resolves no values at all. That is a bigger failure than the one
 * failing closed is guarding against.
 *
 * APW-03 has two usable statuses deliberately, and `AppSpecService` itself
 * treats them as a pair in two places. This reads
 * {@link isUsableAppSpecStatus}, which is that same list — so the env source,
 * the Build source and APW-03's own internals cannot drift apart about what
 * "valid" means.
 *
 * Everything else still fails closed, `missing` and `unreadable` included:
 * those mean "we could not tell", and a spec we could not read is one we must
 * not answer env entries from.
 *
 * ## A snapshot needs a spec, and `AppSpec` is not nullable on it
 *
 * `AppEnvSpecSnapshot.spec` is required. A usable status with a `null` spec
 * would be a contradiction in APW-03's answer, but it is checked rather than
 * asserted: this file would otherwise hand APW-07 a snapshot whose `spec` is
 * `null` against its own type, and every reader downstream would fail somewhere
 * less obvious than here.
 */
export class AppEnvSpecReadSource implements AppEnvSpecSource {
    constructor(private readonly specs: AppSpecService) {}

    async read(workId: string): Promise<AppEnvSpecSnapshot | null> {
        const effective = await this.specs.getEffectiveSpec(workId);
        if (!effective) return null;

        if (!isUsableAppSpecStatus(effective.status)) return null;
        if (!effective.spec) return null;

        return {
            spec: effective.spec,
            specHash: effective.specHash ?? null,
            commitSha: effective.commitSha ?? null,
        };
    }
}
