import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewMissionForm } from '@/components/missions/NewMissionForm';
import { createMissionAction } from '@/app/actions/dashboard/missions';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.missionsPage.newPage');
    return { title: t('title') };
}

/**
 * `/missions/new` — dedicated manual Mission-create page.
 *
 * The `/missions` quick-add composer routes prompts through the chat AI,
 * which means Mission creation only completes if the model calls the
 * `createMission` tool. This is the deterministic, no-AI path: it persists
 * through the existing `createMissionAction` server action. Mirrors
 * `/ideas/new`.
 */
export default function NewMissionPage() {
    return <NewMissionForm createMission={createMissionAction} />;
}
