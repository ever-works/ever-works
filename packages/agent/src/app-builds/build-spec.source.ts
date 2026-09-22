import type { AppSpecService } from '../app-spec/app-spec.service';
import type { AppBuildSpecRead, AppBuildSpecSource } from './app-builds.service';

/**
 * APW-05 — `APP_BUILD_SPEC_SOURCE` over APW-03's `AppSpecService`.
 *
 * Unbound, this epic could not read an App spec at all, so §5.1's
 * `specValidAtCommit` clause could never hold and every Build was refused
 * before it started.
 *
 * ## Why an adapter and not `{ useExisting: AppSpecService }`
 *
 * The port asks four questions; `getEffectiveSpec` answers eleven, and one of
 * them is the one that matters here in a shape the port does not use.
 * `AppSpecEffectiveRead.status` is a six-value string (`valid`,
 * `valid_with_warnings`, `invalid`, `missing`, `unreadable`, `no_state`) and the
 * port wants a boolean. Collapsing it is a DECISION, and it belongs in one
 * place:
 *
 *   - `valid` and `valid_with_warnings` are valid. Warnings do not stop a Build;
 *     APW-03 says so by having two statuses rather than one.
 *   - everything else is not — including `missing` and `unreadable`, which are
 *     "we could not tell" rather than "it is broken". They are the same answer
 *     HERE on purpose: a Build of a commit whose spec we could not read is a
 *     Build we cannot describe, and §5.1 refusing it is the safe direction.
 *
 * Handing `AppSpecService` straight to the token would leave that collapse to
 * whichever caller looked at `status` next, and the two would eventually
 * disagree about whether `unreadable` may build.
 *
 * ## `null` is the absence of an App Work, not the absence of a spec
 *
 * `getEffectiveSpec` answers `null` only for a Work with no App spec state at
 * all. A Work that HAS one but whose spec is missing or invalid answers a read
 * with `valid: false`, which is a different thing and reads differently in the
 * refusal.
 */
export class AppBuildSpecReadSource implements AppBuildSpecSource {
    constructor(private readonly specs: AppSpecService) {}

    async read(workId: string, sha?: string | null): Promise<AppBuildSpecRead | null> {
        const effective = await this.specs.getEffectiveSpec(workId, sha ?? null);
        if (!effective) return null;

        return {
            spec: effective.spec ?? null,
            commitSha: effective.commitSha ?? null,
            specHash: effective.specHash ?? null,
            valid: isUsableStatus(effective.status),
        };
    }
}

/**
 * The two APW-03 statuses a Build may run on.
 *
 * Exported so the collapse is testable on its own and so a reader can find the
 * list without reading the adapter — it is the whole decision this file makes.
 */
export const BUILDABLE_SPEC_STATUSES: readonly string[] = Object.freeze([
    'valid',
    'valid_with_warnings',
]);

/** `true` ⇔ the spec at this commit may be built. */
export function isUsableStatus(status: unknown): boolean {
    return BUILDABLE_SPEC_STATUSES.includes(String(status ?? ''));
}
