import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { workAPI } from '@/lib/api';
import { workAppSpecAPI } from '@/lib/api/work-app-spec';
import { AppSpecPageClient } from '@/components/works/detail/settings/app-spec/AppSpecPageClient';

/**
 * APW-03 T17 — Settings → App spec: `/works/:id/settings/app-spec`
 * (plan §5.1, `plan.md:603-607`; spec §6.2, `spec.md:567-607`).
 *
 * A server component, so the **first paint carries the whole tab** — the status
 * banner, the problems and the sections are all rendered from
 * `GET /api/works/:id/app-spec` before any JavaScript runs, which is what keeps
 * the banner from flashing a different state (plan §5.3, `plan.md:631-632`). The
 * fourth Settings tab that links here landed with T16
 * (`SettingsSubTabs.tsx:58-73`) and is offered for kind `app` only.
 *
 * ## Why the two `notFound()` calls are `notFound()` and not an empty page
 *
 * 1. **The Work is not an App Work.** The kind decides whether `.works/works.yml`
 *    means anything at all: a `website` Work has no App spec, no Blueprint and
 *    no licence gate, and every endpoint of this epic answers `422 notAnAppWork`
 *    for it. The plan fixes this page's behaviour as `notFound()` when
 *    `work.kind !== 'app'` (plan §5.1:604) — the address is withheld, exactly as
 *    the tab is, so a bookmark cannot render an App spec tab about a Work that
 *    cannot have one.
 * 2. **The read itself failed.** `GET /api/works/:id/app-spec` answers `404` for
 *    a Work that is missing, not visible to the caller, or another account's —
 *    one answer for all three, so the route can never be used to discover whose
 *    Work is whose (ACC-03-41). Rendering an empty tab instead would turn "you
 *    may not see this" into "this App Work has no App spec".
 *
 * ## No role gate, deliberately
 *
 * FR-76 requires a **viewer** to be able to read the App spec, and ACC-03-41
 * requires that viewer to see no Re-check control — so the page renders for
 * every role and `AppSpecPageClient` withholds the button from anyone without
 * edit access. This differs from `settings/page.tsx:32`, which gates the General
 * tab on `canAccessSettings` because that form writes; reading is not writing.
 */
export async function generateMetadata(): Promise<Metadata> {
    // The tab's own label, and it exists in every locale: T16 added
    // `dashboard.workDetail.settings.tabs.appSpec` (plan §8:744).
    const t = await getTranslations('dashboard.workDetail.settings.tabs');
    return { title: t('appSpec') };
}

type Params = { params: Promise<{ id: string }> };

export default async function WorkAppSpecSettingsPage({ params }: Params) {
    const { id } = await params;

    let kind: string | undefined;

    try {
        const res = await workAPI.get(id);
        kind = res.work.kind;
    } catch {
        notFound();
    }

    if (kind !== 'app') {
        notFound();
    }

    let state;

    try {
        state = await workAppSpecAPI.get(id);
    } catch {
        notFound();
    }

    return <AppSpecPageClient workId={id} initialState={state} />;
}
