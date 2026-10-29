import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { TASK_DELIVERY_FILTER_GROUPS } from '@ever-works/contracts';
import { tasksAPI } from '@/lib/api/tasks';
import { workAPI } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { TasksScopedSection } from '@/components/tasks/TasksScopedSection';
import { TasksFilterSelects } from '@/components/tasks/TasksFilterSelects';
import { parseTaskDeliveryFilter } from '@/lib/task-delivery-filter';

export const metadata: Metadata = { title: 'Tasks' };

/**
 * Tasks feature — Phase 14.3. Tasks tab under /works/[id]/tasks.
 * Filters the global list by `workId`. Inherits the WorkLayout's
 * tab strip + WorkDetailContext so the work's header/sidebar are
 * shared automatically.
 *
 * The shared work-detail layout already mounts under
 * `/works/[id]/layout.tsx`; this page slots in as a sibling of
 * `items` / `kb` / `generator`. No tab-array registration needed
 * — the layout reads route segments dynamically.
 *
 * APW-08 T27 — the rows carry their delivery embed (`includeDelivery`), so a merged App Work
 * change shows its delivery chip on the cards, the table and the board; an App Work's tab also
 * gets the **Delivery** filter (`?delivery=`, spec §6.1). Every other Work kind is unchanged.
 */
export default async function WorkTasksTabPage({
    params,
    searchParams,
}: {
    params: Promise<{ id: string }>;
    searchParams?: Promise<{ delivery?: string | string[] }>;
}) {
    const { id } = await params;
    const query = (await searchParams) ?? {};
    const deliveryParam = Array.isArray(query.delivery) ? query.delivery[0] : query.delivery;
    // The Delivery select is only offered on an App Work, so `?delivery=` only ever comes from
    // there; it is parsed (unknown = Any) and read in the same round trip as the rest.
    const delivery = parseTaskDeliveryFilter(deliveryParam);
    // Wave 4 M4 — the fleet summary chips ride the Tasks tab header.
    // Best-effort: a summary miss must never break the Tasks tab, and a Work read miss only
    // withholds the Delivery filter (the layout owns the not-found answer).
    const [result, runsSummary, work] = await Promise.all([
        tasksAPI.list({
            workId: id,
            limit: 100,
            includeRun: true,
            includeDelivery: true,
            ...(delivery ? { deliveryState: TASK_DELIVERY_FILTER_GROUPS[delivery] } : {}),
        }),
        workAPI.getRunsSummary(id).catch(() => null),
        workAPI
            .get(id)
            .then((res) => res.work)
            .catch(() => null),
    ]);
    const isAppWork = work?.kind === 'app';
    const t = await getTranslations('dashboard.tasksPage.delivery');

    return (
        <div className="p-6 max-w-screen-2xl mx-auto">
            {isAppWork && (
                <form
                    className="mb-4 flex flex-wrap items-end gap-2"
                    data-testid="work-tasks-delivery-filter"
                >
                    <TasksFilterSelects
                        key={delivery ?? 'any'}
                        showDelivery
                        deliveryOnly
                        defaultDelivery={delivery}
                    />
                    <Button type="submit" size="sm">
                        {t('filterApply')}
                    </Button>
                </form>
            )}
            <TasksScopedSection
                tasks={result.data}
                scopeLabel="Work"
                scopeId={id}
                runsSummary={runsSummary}
            />
        </div>
    );
}
