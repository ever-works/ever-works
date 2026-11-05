import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewMissionForm, type NewMissionFormTemplate } from '@/components/missions/NewMissionForm';
import { createMissionAction } from '@/app/actions/dashboard/missions';
import { missionsAPI } from '@/lib/api/missions';
import { templatesAPI } from '@/lib/api/templates';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.missionsPage.newPage');
    return { title: t('title') };
}

/** A catalog Mission template id (the API refuses anything else with 400 / 404). */
const TEMPLATE_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;

type SearchParams = Promise<{ template?: string | string[] }>;

/**
 * `/missions/new` — dedicated manual Mission-create page.
 *
 * The `/missions` quick-add composer routes prompts through the chat AI,
 * which means Mission creation only completes if the model calls the
 * `createMission` tool. This is the deterministic, no-AI path: it persists
 * through the existing `createMissionAction` server action. Mirrors
 * `/ideas/new`.
 *
 * APW-08 T40 — `?template=<id>` opens the form on a catalog Mission template: the template rides
 * on the Mission, and a template about an App Work (its manifest has `appWork`) adds its Product /
 * Business / App Work fields and summary — the same component the catalog's **Use this Template**
 * path renders on `/new`.
 */
export default async function NewMissionPage({ searchParams }: { searchParams?: SearchParams }) {
    const params = (await searchParams) ?? {};
    // A repeated `?template=` arrives as an array: only a single value names a template.
    const templateId = typeof params.template === 'string' ? params.template.trim() : '';
    let template: NewMissionFormTemplate | null = null;
    let initialDescription = '';
    if (TEMPLATE_ID_RE.test(templateId)) {
        const [list, manifest] = await Promise.all([
            templatesAPI.list('mission').catch(() => ({
                templates: [] as Array<{ id: string; name: string; description?: string | null }>,
            })),
            missionsAPI.templateManifest(templateId),
        ]);
        const row = list.templates.find((candidate) => candidate.id === templateId);
        if (row) {
            template = { id: row.id, manifest };
            initialDescription = (row.description ?? '').trim();
        }
    }
    return (
        <NewMissionForm
            createMission={createMissionAction}
            template={template}
            initialDescription={initialDescription}
        />
    );
}
