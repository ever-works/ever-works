/**
 * Tasks upgrades — workflow Task Template types shared with `'use client'`
 * components (no `server-only` imports here; the fetchers live in
 * `task-templates.ts`).
 */

import type { TaskExtraRepo } from '@ever-works/contracts';

export interface TaskTemplateStepRow {
    id: string;
    templateId: string;
    position: number;
    title: string;
    prompt: string | null;
    agentId: string | null;
    agentTemplateSlug: string | null;
    requiresApproval: boolean;
    dependsOn: number[] | null;
    /**
     * Multi-repo decomposition (slice AH): the Work THIS step files its
     * sub-task against, and the extra repositories that sub-task mounts.
     * `null` on both = inherit the tree's Work, mount nothing extra.
     */
    workId: string | null;
    extraRepos: TaskExtraRepo[] | null;
    createdAt: string;
}

export interface TaskTemplateRow {
    id: string;
    userId: string;
    name: string;
    slug: string;
    description: string | null;
    labels: string[] | null;
    steps: TaskTemplateStepRow[];
    createdAt: string;
    updatedAt: string;
}

export interface InstantiateTemplateInput {
    title: string;
    description?: string | null;
    workId?: string | null;
    missionId?: string | null;
    ideaId?: string | null;
    branchName?: string | null;
}
