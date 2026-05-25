'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { skillsAPI, type Skill, type SkillBinding, type SkillFrontmatter, type SkillOwnerType, type SkillBindingTargetType } from '@/lib/api/skills';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 9 server actions for the
 * Skills feature. Each mutation invalidates `/skills` so the page
 * re-fetches on the next render.
 *
 * `installCatalogSkillAction` defaults to tenant-scope using the
 * current userId as ownerId. The userId is read from the auth
 * cookie at server-action time (cookies()), keeping the client
 * surface minimal.
 */

async function getCurrentUserId(): Promise<string> {
    // The platform's existing auth cookie carries the userId in the JWT
    // claim; the actual decoding lives in `lib/auth.ts`. Server actions
    // that need user-scoped data should call through a shared helper —
    // we keep the import shallow here to avoid pulling JWT internals
    // into this thin wrapper. The real value is plumbed through
    // serverFetch which already attaches the cookie automatically.
    const cookieStore = await cookies();
    const uid = cookieStore.get('user-id')?.value;
    if (!uid) throw new Error('Not authenticated');
    return uid;
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
    ownerId: string;
    title: string;
    description: string;
    instructionsMd: string;
    frontmatter?: SkillFrontmatter;
    slug?: string;
}): Promise<Skill> {
    const skill = await skillsAPI.create(input);
    revalidatePath('/skills');
    return skill;
}

export async function updateSkillAction(
    id: string,
    body: Partial<Pick<Skill, 'title' | 'description' | 'instructionsMd' | 'frontmatter' | 'version'>>,
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
