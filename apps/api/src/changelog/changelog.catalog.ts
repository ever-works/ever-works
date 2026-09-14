import type { ChangelogSourceEntry } from '@ever-works/contracts/api';

/**
 * What's new (AW-14) — the product changelog entries that ship with this
 * build.
 *
 * Entries live in the repository, next to the code they describe: announcing
 * a change is one more record added in the same pull request that ships it,
 * reviewed by the same reviewer and released by the same deploy. There is no
 * runtime authoring surface (spec FR-3) and no network call to obtain them
 * (spec FR-1), so a deployment can only ever describe what its build contains.
 *
 * This file is read through the `ChangelogEntrySource` port
 * (`changelog-entry-source.ts`) by `BundledChangelogEntrySource`; another
 * source can replace it without touching the service, controller or web app.
 *
 * Authoring rules — enforced by `changelog.catalog.spec.ts` in CI and
 * re-validated when the API loads the entries:
 *  - `slug`: lowercase `[a-z0-9-]`, 3–64 characters, unique, never reused —
 *    it is the permalink;
 *  - `title` ≤ 80 characters; `body` ≤ 600 characters, plain text, at most 3
 *    paragraphs separated by a blank line, written for a non-technical owner;
 *  - `category`: one of the six product areas; `kind`: new / improved /
 *    fixed / security;
 *  - `publishedAt`: ISO-8601. A future date keeps the entry hidden until then;
 *  - `pinned`: at most one entry in the whole list;
 *  - `cta`: optional; `label` ≤ 32 characters and `href` an in-product path
 *    that begins with exactly one `/`.
 *
 * Order here is by convention newest first; the API sorts regardless.
 */
export const CHANGELOG_ENTRIES: readonly ChangelogSourceEntry[] = [
    {
        slug: 'security-update-web-and-api-2026-09',
        title: 'Security update for the web app and API',
        body: 'We updated the web framework and several server libraries to close critical and high-severity security advisories.\n\nNo action is needed on your side.',
        category: 'platform',
        kind: 'security',
        publishedAt: '2026-09-13T12:00:00.000Z',
    },
    {
        slug: 'releases-verified-after-deploy',
        title: 'Releases are checked after they deploy',
        body: 'Once a release promotion merges, Ever Works now confirms that the expected version is actually live before calling it done.\n\nIf the check keeps failing, you are offered a revert to approve. A revert is never applied on its own.',
        category: 'platform',
        kind: 'new',
        publishedAt: '2026-09-07T12:00:00.000Z',
    },
    {
        slug: 'approve-agent-merges-in-inbox',
        title: "Approve an agent's merge from your Inbox",
        body: "When an agent's pull request is green and reviewed, Ever Works now asks you in your Inbox before it merges. Nothing merges without your approval, and approving checks that the pull request is still the one you reviewed.",
        category: 'decisions',
        kind: 'new',
        publishedAt: '2026-09-06T12:00:00.000Z',
        cta: { label: 'Open Inbox', href: '/inbox' },
    },
    {
        slug: 'task-templates-span-repositories',
        title: 'Task templates can span several repositories',
        body: 'Each step of a task template can now work in its own repository. Sub-tasks that were waiting on another one no longer wait for someone to notice: they become ready as soon as the work they depend on is done.',
        category: 'agents',
        kind: 'improved',
        publishedAt: '2026-09-05T15:00:00.000Z',
        cta: { label: 'Open task templates', href: '/tasks/templates' },
    },
    {
        slug: 'fleet-run-costs-and-daily-ceilings',
        title: 'Runs on your own machines now report what they cost',
        body: 'Runs executed on your fleet nodes now record their cost and token counts, so budgets and cost views no longer show $0.00 for them.\n\nYou can also set a daily spending ceiling for one node or for the whole fleet. Crossing it pauses the affected nodes and leaves a notice in your Inbox.',
        category: 'costs',
        kind: 'new',
        publishedAt: '2026-09-05T12:00:00.000Z',
        cta: { label: 'Set a ceiling', href: '/settings/fleet' },
    },
    {
        slug: 'stop-the-whole-fleet',
        title: 'Stop your whole fleet in one step',
        body: 'A single control now drains every one of your nodes at once and holds new work until you resume. While the stop is on, nothing slips through to cloud execution instead.',
        category: 'connections',
        kind: 'new',
        publishedAt: '2026-09-05T09:00:00.000Z',
        cta: { label: 'Open fleet settings', href: '/settings/fleet' },
    },
];
