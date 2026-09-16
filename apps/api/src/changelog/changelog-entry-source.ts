import type { ChangelogSourceEntry } from '@ever-works/contracts/api';

/**
 * What's new (AW-14) — the port every product changelog content source
 * implements.
 *
 * `ChangelogService` depends on this interface and the
 * {@link CHANGELOG_ENTRY_SOURCE} token, never on where entries come from.
 * Today the only binding is `BundledChangelogEntrySource`, which reads the
 * entries file committed in this repository (`changelog.catalog.ts`). A
 * different source — for example one that reads a generated file, or a
 * plugin-provided source for a deployment that wants to announce its own
 * changes — is a new class bound to the same token in `ChangelogModule`,
 * with no change to the service, the controller or the web app.
 *
 * Contract for implementations:
 *  - return the complete list of entries the deployment should know about,
 *    including future-dated ones (the service hides those until their date);
 *  - never filter per reader — read state and visibility are the service's
 *    job, and every reader sees the same entries (spec §7.2);
 *  - reject (throw) when the entries cannot be obtained. The service keeps
 *    serving the last good load where it has one, and otherwise surfaces the
 *    failure as the panel's retryable error state rather than an empty list
 *    that would read as "nothing has ever shipped";
 *  - do not validate; the service validates every record on load and drops
 *    or repairs anything that breaks the authoring rules.
 */
export interface ChangelogEntrySource {
    /** Short, stable identifier used in logs, e.g. `bundled`. */
    readonly id: string;

    /** Every entry this source knows about, in any order. */
    load(): Promise<readonly ChangelogSourceEntry[]>;
}

/** DI token for the bound {@link ChangelogEntrySource}. */
export const CHANGELOG_ENTRY_SOURCE = Symbol('CHANGELOG_ENTRY_SOURCE');
