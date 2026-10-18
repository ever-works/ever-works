import { isAppWorkKind, isProjectWorkKind, isRepositoryWorkKind } from '@ever-works/contracts';
import type { Work } from '../../entities/work.entity';

/**
 * Does this Work have a directory data repository whose cache columns
 * (`configCache` + counts) `refreshDataCache` can fill?
 *
 * `false` for the three kinds whose repository is not a generated directory
 * corpus: `app` (APW-01 — an existing code repository linked, forked or
 * copied), `repo` (EW-766 — a human's source tree) and `project` (no
 * repository at all). A KIND test, like the predicates it composes, and it
 * never throws on an unknown kind (that is the generic `default`, which has a
 * data repository).
 */
export function workHasDirectoryDataCache(work: Pick<Work, 'kind'> | null | undefined): boolean {
    const kind = work?.kind;
    return !isAppWorkKind(kind) && !isRepositoryWorkKind(kind) && !isProjectWorkKind(kind);
}
