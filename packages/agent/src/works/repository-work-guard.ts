import { BadRequestException } from '@nestjs/common';
import { getWorkCapabilities, isRepositoryWorkKind } from '@ever-works/contracts';
import type { RepositoryRole } from '@ever-works/contracts/api';

/**
 * Repository Work guard (self-build slice D, EW-766).
 *
 * A `repo` Work wraps an EXISTING code repository — `ever-works/ever-works`,
 * a template repo, a customer's service — and registers it as the Work's
 * data repository so Tasks, Goals and fleet runs can attach to it. The
 * platform never created that repository, so it must never delete, archive,
 * rewrite or generate INTO it. Every pipeline that clones the data
 * repository and commits to it (item submission, generation, README
 * regeneration, comparisons, source validation, community-PR intake, the
 * website template sync) is therefore off-limits for the kind, and every
 * repository role the kind never provisions (`work`, `website`) must not be
 * resolved into a real repository name under the third-party owner.
 *
 * This is the ONE place that knowledge lives. Entry points call
 * `assertNotRepositoryWork` / `assertRepositoryRole` rather than testing
 * `work.kind` inline, so a new pipeline cannot forget the check and a change
 * to the rule is a one-file change. The web app hides the same surfaces
 * through `WORK_KIND_CAPABILITIES.repo`; this is the API boundary catching a
 * direct call, an MCP tool, a scheduled job or an internal caller.
 *
 * Deliberately a KIND test (via `isRepositoryWorkKind`), not a capability
 * test — see the contracts doc on `isRepositoryWorkKind`: the content
 * pipelines are not capability-gated for any other kind today, and a Landing
 * Page (`items.enabled: false`) still generates. Only the REPOSITORY ROLES
 * go through the capability registry, because "this kind provisions no
 * website repository" is exactly what `repos.website` already records for
 * Company and Campaign Works too.
 */

/**
 * The minimum a caller has to hand over: the persisted kind plus whatever
 * names the Work in an error. Structural rather than the `Work` entity on
 * purpose — Works reach several services as spread plain objects
 * (`{ ...dir }`), the case `shouldGenerateProviderRepository` documents — so
 * an entity-typed parameter would reject those callers at compile time and
 * an entity method would throw `is not a function` at runtime.
 */
export interface WorkKindSubject {
    readonly kind?: string | null;
    readonly name?: string | null;
    readonly slug?: string | null;
}

/** Stable prefix every refusal starts with, so callers and specs can match on it. */
export const REPOSITORY_WORK_REFUSAL = 'is a Repository Work';

function describeWork(work: WorkKindSubject): string {
    const label = work.name || work.slug;
    return label ? `Work "${label}"` : 'This Work';
}

/** True when the Work wraps an existing code repository (`kind: 'repo'`). */
export function isRepositoryWork(work: WorkKindSubject): boolean {
    return isRepositoryWorkKind(work.kind);
}

/**
 * Refuse an operation that would clone, write into, or otherwise act on a
 * Repository Work's data repository as if the platform had generated it.
 *
 * `action` is the human-readable name of what was attempted ("item
 * submission", "README regeneration", …) so the 400 says what was refused
 * and why, not just that something was.
 */
export function assertNotRepositoryWork(work: WorkKindSubject, action: string): void {
    if (!isRepositoryWork(work)) {
        return;
    }
    throw new BadRequestException(
        `${describeWork(work)} ${REPOSITORY_WORK_REFUSAL} — ${action} is not available for it: ` +
            'its data repository is the code repository itself and nothing is generated for it',
    );
}

/**
 * Whether this kind provisions the given repository role at all.
 *
 * `Work.getMainRepo()` / `getWebsiteRepo()` fall back to a DERIVED name
 * (`<slug>`, `<slug>-website`) under the Work's owner when no role is
 * recorded. For a kind that never provisions the role that fallback names
 * a repository that does not exist — or, for a Repository Work whose slug
 * is derived from the wrapped repository, names the wrapped repository
 * itself. Callers that are about to delete, list or change the visibility
 * of a role must check this first.
 */
export function hasRepositoryRole(work: WorkKindSubject, role: RepositoryRole): boolean {
    return getWorkCapabilities(work.kind).repos[role];
}

/** Refuse an operation on a repository role this kind never provisions. */
export function assertRepositoryRole(work: WorkKindSubject, role: RepositoryRole): void {
    if (hasRepositoryRole(work, role)) {
        return;
    }
    const reason = isRepositoryWork(work)
        ? `${REPOSITORY_WORK_REFUSAL} and provisions no ${role} repository`
        : `is a "${work.kind ?? 'default'}" Work and provisions no ${role} repository`;
    throw new BadRequestException(`${describeWork(work)} ${reason}`);
}
