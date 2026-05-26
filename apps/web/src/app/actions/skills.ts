'use server';

import { revalidatePath } from 'next/cache';
import {
    skillsAPI,
    type Skill,
    type SkillBinding,
    type SkillFrontmatter,
    type SkillOwnerType,
    type SkillBindingTargetType,
} from '@/lib/api/skills';
import { getAuthFromCookie } from '@/lib/auth';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 9 server actions for the
 * Skills feature. Each mutation invalidates `/skills` so the page
 * re-fetches on the next render.
 *
 * `installCatalogSkillAction` defaults to tenant-scope using the
 * current userId as ownerId. The userId is read from the encrypted
 * auth cookie (`everworks_auth_token`) at server-action time via
 * `getAuthFromCookie()`.
 */

async function getCurrentUserId(): Promise<string> {
    // Review-fix C2: previously read a non-existent `user-id` cookie,
    // which broke every "Install" click on /skills. The real auth cookie
    // is `everworks_auth_token` (encrypted JWT) — use the shared helper
    // that decodes it.
    const user = await getAuthFromCookie();
    if (!user?.id) throw new Error('Not authenticated');
    return user.id;
}

export async function installCatalogSkillAction(input: {
    slug: string;
    ownerType?: SkillOwnerType;
    ownerId?: string;
}): Promise<Skill> {
    const ownerType: SkillOwnerType = input.ownerType ?? 'tenant';
    const ownerId = input.ownerId ?? (await getCurrentUserId());
    const skill = await skillsAPI.install({ slug: input.slug, ownerType, ownerId });
    revalidatePath('/skills');
    return skill;
}

export async function createCustomSkillAction(input: {
    ownerType: SkillOwnerType;
    /**
     * PASS-4 review fix: ownerId can be empty for tenant scope —
     * we derive it from the auth cookie server-side. Callers that
     * already know the ownerId (e.g. binding to a specific Mission)
     * keep passing it explicitly.
     */
    ownerId: string;
    title: string;
    description: string;
    instructionsMd: string;
    frontmatter?: SkillFrontmatter;
    slug?: string;
}): Promise<Skill> {
    const ownerId =
        input.ownerType === 'tenant' && !input.ownerId ? await getCurrentUserId() : input.ownerId;
    const skill = await skillsAPI.create({ ...input, ownerId });
    revalidatePath('/skills');
    return skill;
}

export async function updateSkillAction(
    id: string,
    body: Partial<
        Pick<Skill, 'title' | 'description' | 'instructionsMd' | 'frontmatter' | 'version'>
    >,
): Promise<Skill> {
    const skill = await skillsAPI.update(id, body);
    revalidatePath('/skills');
    revalidatePath(`/skills/${id}`);
    return skill;
}

export async function deleteSkillAction(id: string): Promise<{ deleted: true }> {
    const res = await skillsAPI.remove(id);
    revalidatePath('/skills');
    return res;
}

export async function createBindingAction(
    skillId: string,
    body: {
        targetType: SkillBindingTargetType;
        targetId?: string | null;
        priority?: number;
        injectIntoAgent?: boolean;
        injectIntoGenerator?: boolean;
    },
): Promise<SkillBinding> {
    const res = await skillsAPI.createBinding(skillId, body);
    revalidatePath(`/skills/${skillId}`);
    return res;
}

export async function deleteBindingAction(bindingId: string): Promise<{ deleted: true }> {
    const res = await skillsAPI.deleteBinding(bindingId);
    revalidatePath('/skills');
    return res;
}

/**
 * FU-8 post-CI fix: the binding-target picker on `SkillDetailClient`
 * (a `'use client'` component) needs the user's Agents / Missions /
 * Ideas / Works to populate the dropdown. Importing the API clients
 * (`agentsAPI` / `missionsAPI` / `workProposalsAPI` / `workAPI`)
 * directly from a client component pulls their `import 'server-only'`
 * declarations into the client bundle and breaks the Next.js build:
 *
 *   x You're importing a module that depends on "server-only".
 *     This API is only available in Server Components in the App
 *     Router, but you are using it in the Pages Router.
 *
 * This server action wraps the four lookups so the client component
 * gets the data it needs without dragging server-only modules across
 * the boundary.
 */
export async function loadBindingTargetOptionsAction(
    targetType: SkillBindingTargetType,
): Promise<Array<{ id: string; label: string }>> {
    if (targetType === 'tenant') return [];
    // Lazy-import the server-only API clients so this action stays
    // pruned of paths that won't run for the targetType in hand.
    if (targetType === 'agent') {
        const { agentsAPI } = await import('@/lib/api/agents');
        const res = await agentsAPI.list({ limit: 100 });
        return (res.data ?? []).map((a) => ({
            id: a.id,
            label: `${a.name} (${a.slug})`,
        }));
    }
    if (targetType === 'mission') {
        const { missionsAPI } = await import('@/lib/api/missions');
        const res = await missionsAPI.list();
        return (res ?? []).map((m) => ({ id: m.id, label: m.title }));
    }
    if (targetType === 'idea') {
        const { workProposalsAPI } = await import('@/lib/api/work-proposals');
        const res = await workProposalsAPI.list(['pending', 'accepted']);
        return (res ?? []).map((p) => ({ id: p.id, label: p.title }));
    }
    if (targetType === 'work') {
        const { workAPI } = await import('@/lib/api/work');
        const res = await workAPI.getAll({ limit: 100 });
        const works = (res?.works ?? []) as Array<{ id: string; name: string }>;
        return works.map((w) => ({ id: w.id, label: w.name }));
    }
    return [];
}
