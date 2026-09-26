import type { ImportSourceType } from '@ever-works/contracts/api';

export const LINKED_WORK_SYNC_UNSUPPORTED_MESSAGE =
    'Linked works use existing repositories directly and cannot be synced from an import source.';

const SYNCABLE_SOURCE_TYPES = new Set<ImportSourceType>([
    'data_repo',
    'awesome_readme',
    'works_config',
]);

/**
 * Whether a Work's `sourceRepository.type` names an import source that can be
 * synced.
 *
 * The parameter is deliberately `string | null | undefined` (APW-01 T4,
 * `plan.md:319-320`): since APW-01 widened `SourceRepository.type` to
 * `ImportSourceType | AppSourceRepositoryType`, a caller can hand this an
 * `app_link` / `app_fork` / `app_private_copy` — and a Work whose source is one of
 * those must answer `false`, which the unchanged whitelist already does. Widening
 * the parameter is what keeps the three `app_*` members from being a type error at
 * every call site; it does not make anything syncable. An unknown string answers
 * `false` too, so a future source type cannot become syncable by accident.
 */
export function supportsWorkSourceSync(sourceType?: string | null): boolean {
    return !!sourceType && (SYNCABLE_SOURCE_TYPES as ReadonlySet<string>).has(sourceType);
}
