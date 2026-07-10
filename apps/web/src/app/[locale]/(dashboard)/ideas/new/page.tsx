import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { NewIdeaForm } from '@/components/ideas/NewIdeaForm';
import { createIdeaAction } from '@/app/actions/dashboard/work-proposals';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('dashboard.ideasPage.newPage');
    return { title: t('title') };
}

/**
 * `/ideas/new` — dedicated manual Idea-create page. The `/ideas`
 * quick-add composer routes prompts through the chat AI; this is the
 * deterministic, no-AI path that persists a `USER_MANUAL` Idea via
 * the existing `createIdeaAction` server action.
 */
export default function NewIdeaPage() {
    return <NewIdeaForm createIdea={createIdeaAction} />;
}
