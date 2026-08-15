/**
 * Tasks upgrades — workflow Task Template types shared with `'use client'`
 * components (no `server-only` imports here; the fetchers live in
 * `task-templates.ts`).
 */

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
