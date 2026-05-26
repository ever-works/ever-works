import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { skillsAPI, type SkillBinding } from '@/lib/api/skills';
import { SkillDetailClient } from '@/components/skills/SkillDetailClient';

export async function generateMetadata({
    params,
}: {
    params: Promise<{ id: string }>;
}): Promise<Metadata> {
    const { id } = await params;
    const skill = await skillsAPI.get(id);
    return { title: skill?.title ?? 'Skill' };
}

/**
 * Agents/Skills/Tasks PR #1017 — Phase 9.4. `/skills/[id]` detail
 * page. Server-fetches the Skill + its bindings in parallel.
 * Cross-user 404 cascades via skillsAPI.get returning null.
 *
 * v1 ships a 2-section layout (Body + Bindings) instead of a tab
 * strip — the page is short enough that a vertical scroll is
 * clearer than tabs. Tiptap body editor lands once the shared
 * KbEditor toolbar is extracted; v1 uses a plain textarea with
 * the same 800ms autosave + secret/size error banner pattern as
 * the Agent Instructions editor.
 */
export default async function SkillDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const [skill, bindings] = await Promise.all([
        skillsAPI.get(id),
        skillsAPI.listBindings(id).catch(() => [] as SkillBinding[]),
    ]);
    if (!skill) notFound();

    return <SkillDetailClient skill={skill} initialBindings={bindings} />;
}
