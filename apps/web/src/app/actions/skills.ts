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
