import 'server-only';
import { serverFetch, serverMutation } from './server-api';

/**
 * Agents/Skills/Tasks PR #1017 — Phase 9 web client mirroring the
 * agent-side `Skill` / `SkillBinding` types. Kept in lockstep
 * manually so apps/web doesn't take a runtime dep on @ever-works/agent.
 */

export type SkillOwnerType = 'tenant' | 'mission' | 'idea' | 'work' | 'agent';
export type SkillBindingTargetType = 'agent' | 'work' | 'mission' | 'idea' | 'tenant';

export interface SkillFrontmatter {
    name: string;
    description: string;
    allowedTools?: string[];
    tags?: string[];
    [key: string]: unknown;
}

export type SkillFileKind = 'script' | 'reference' | 'asset' | 'config';

export interface SkillFile {
    id: string;
    skillId: string;
    userId: string;
    uploadId: string;
    filename: string;
    kind: SkillFileKind;
    sizeBytes: number;
    mime: string;
    createdAt: string;
    updatedAt: string;
}

export interface InvocableSkill {
    id: string;
    title: string;
    slug: string;
    invocationSlug: string;
    description: string;
}

export interface Skill {
    id: string;
    userId: string;
    ownerType: SkillOwnerType;
    ownerId: string;
    slug: string;
    invocationSlug?: string | null;
    title: string;
    description: string;
    frontmatter: SkillFrontmatter;
    instructionsMd: string;
    contentHash: string;
    sourcePath: string | null;
    sourceCatalogSlug: string | null;
    sourceCatalogVersion: string | null;
    version: string;
    createdAt: string;
    updatedAt: string;
}

export interface SkillBinding {
    id: string;
    skillId: string;
    targetType: SkillBindingTargetType;
    targetId: string | null;
    userId: string;
    injectIntoAgent: boolean;
    injectIntoGenerator: boolean;
    priority: number;
    createdAt: string;
}

export interface SkillCatalogEntry {
    slug: string;
    title: string;
    description: string;
    frontmatter: SkillFrontmatter;
    body: string;
    version: string;
    tags: string[];
    sourceUrl?: string;

    /**
     * Provenance for entries that came from an Agent Plugins package.
     *
     * This interface is a hand-maintained MIRROR of the one in
     * `packages/plugin/src/contracts/capabilities/skills-provider.interface.ts`
     * — the web app does not import that package's type. Adding a field there
     * and not here is invisible: the API sends it, nothing strips it, and the
     * UI simply never sees it. That failure shows up as "the source label
     * never renders", not as a type error, so the two must be changed
     * together.
     */
    packageName?: string;
    packageVersion?: string;
    sourceKind?: 'plugin' | 'local' | 'git' | 'npm';
}

export interface ListResponse<T> {
    data?: T[];
    entries?: T[];
    meta?: { total: number; limit: number; offset: number };
    total?: number;
}

export const skillsAPI = {
    async listInstalled(
        query: {
            ownerType?: SkillOwnerType;
            search?: string;
            limit?: number;
            offset?: number;
        } = {},
    ) {
        const params = new URLSearchParams();
        if (query.ownerType) params.set('ownerType', query.ownerType);
        if (query.search) params.set('search', query.search);
        if (query.limit !== undefined) params.set('limit', String(query.limit));
        if (query.offset !== undefined) params.set('offset', String(query.offset));
        const qs = params.toString();
        return serverFetch<{
            data: Skill[];
            meta: { total: number; limit: number; offset: number };
        }>(`/skills${qs ? `?${qs}` : ''}`, { method: 'GET' });
    },

    async listCatalog(
        query: { search?: string; tags?: string[]; limit?: number; offset?: number } = {},
    ) {
        const params = new URLSearchParams();
        if (query.search) params.set('search', query.search);
        if (query.tags?.length) params.set('tags', query.tags.join(','));
        if (query.limit !== undefined) params.set('limit', String(query.limit));
        if (query.offset !== undefined) params.set('offset', String(query.offset));
        const qs = params.toString();
        return serverFetch<{ entries: SkillCatalogEntry[]; total: number }>(
            `/skills/catalog${qs ? `?${qs}` : ''}`,
            { method: 'GET' },
        );
    },

    async get(id: string) {
        try {
            return await serverFetch<Skill>(`/skills/${id}`, { method: 'GET' });
        } catch {
            return null;
        }
    },

    async install(body: { slug: string; ownerType: SkillOwnerType; ownerId: string }) {
        return serverMutation<Skill>({
            endpoint: '/skills/install',
            data: body,
            method: 'POST',
            wrapInData: false,
        });
    },

    async create(body: {
        ownerType: SkillOwnerType;
        ownerId: string;
        title: string;
        description: string;
        instructionsMd: string;
        frontmatter?: SkillFrontmatter;
        slug?: string;
        invocationSlug?: string | null;
    }) {
        return serverMutation<Skill>({
            endpoint: '/skills',
            data: body,
            method: 'POST',
            wrapInData: false,
        });
    },

    async update(
        id: string,
        body: Partial<
            Pick<
                Skill,
                | 'title'
                | 'description'
                | 'instructionsMd'
                | 'frontmatter'
                | 'version'
                | 'invocationSlug'
            >
        >,
    ) {
        return serverMutation<Skill>({
            endpoint: `/skills/${id}`,
            data: body as Record<string, unknown>,
            method: 'PATCH',
            wrapInData: false,
        });
    },

    async remove(id: string) {
        return serverMutation<{ deleted: true }>({
            endpoint: `/skills/${id}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async listBindings(skillId: string) {
        return serverFetch<SkillBinding[]>(`/skills/${skillId}/bindings`, { method: 'GET' });
    },

    async createBinding(
        skillId: string,
        body: {
            targetType: SkillBindingTargetType;
            targetId?: string | null;
            priority?: number;
            injectIntoAgent?: boolean;
            injectIntoGenerator?: boolean;
        },
    ) {
        return serverMutation<SkillBinding>({
            endpoint: `/skills/${skillId}/bindings`,
            data: body,
            method: 'POST',
            wrapInData: false,
        });
    },

    async deleteBinding(bindingId: string) {
        return serverMutation<{ deleted: true }>({
            endpoint: `/skill-bindings/${bindingId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    // ── Skill files (companion files) ────────────────────────────

    async listFiles(skillId: string) {
        return serverFetch<SkillFile[]>(`/skills/${skillId}/files`, { method: 'GET' });
    },

    async deleteFile(skillId: string, fileId: string) {
        return serverMutation<{ deleted: true }>({
            endpoint: `/skills/${skillId}/files/${fileId}`,
            data: {},
            method: 'DELETE',
            wrapInData: false,
        });
    },

    async listInvocable() {
        return serverFetch<{ data: InvocableSkill[] }>('/skills/invocable', { method: 'GET' });
    },
};
