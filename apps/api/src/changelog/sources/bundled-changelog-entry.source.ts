import type { ChangelogSourceEntry } from '@ever-works/contracts/api';
import type { ChangelogEntrySource } from '../changelog-entry-source';
import { CHANGELOG_ENTRIES } from '../changelog.catalog';

/**
 * What's new (AW-14) — the default content source: the entries file that is
 * committed in this repository and compiled into the build.
 *
 * Because the list is part of the build, a deployment can only describe the
 * changes its own build contains (spec FR-1, S-14), and a rollback removes the
 * entries that arrived with the rolled-back code.
 *
 * Bound through a factory in `ChangelogModule` (not constructor-injected),
 * so the optional `entries` argument stays a plain value that specs can
 * supply without a Nest container.
 */
export class BundledChangelogEntrySource implements ChangelogEntrySource {
    readonly id = 'bundled';

    constructor(private readonly entries: readonly ChangelogSourceEntry[] = CHANGELOG_ENTRIES) {}

    async load(): Promise<readonly ChangelogSourceEntry[]> {
        return this.entries;
    }
}
