/**
 * Saved workflow graphs — wire types for `GET /api/workflows*`, shared with
 * `'use client'` components (no `server-only` imports; the fetchers live in
 * `workflows.ts`).
 */

import type { WorkflowGraph } from '@ever-works/contracts';

export type WorkflowStatus = 'draft' | 'active' | 'archived';
export type WorkflowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface WorkflowRow {
    id: string;
    userId: string;
    name: string;
    description?: string | null;
    status: WorkflowStatus;
    graph: WorkflowGraph;
    workId?: string | null;
    runCount: number;
    lastRunAt?: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface WorkflowRunNodeTrace {
    readonly nodeId: string;
    readonly ok: boolean;
    readonly failureCode?: string;
    readonly error?: string;
}

export interface WorkflowRunDecisionTrace {
    readonly nodeId: string;
    readonly choice: string;
    readonly rationale?: string;
    readonly degraded?: boolean;
}

export interface WorkflowRunTraceData {
    readonly visited: readonly string[];
    readonly nodes: readonly WorkflowRunNodeTrace[];
    readonly traversedEdges: readonly string[];
    readonly decisions: readonly WorkflowRunDecisionTrace[];
    readonly errors: readonly string[];
    readonly truncated?: boolean;
}

/** A run-history row (the list omits `trace` and `output`). */
export interface WorkflowRunRow {
    id: string;
    workflowId: string;
    status: WorkflowRunStatus;
    startedAt?: string | null;
    finishedAt?: string | null;
    durationMs?: number | null;
    errorMessage?: string | null;
    failureCode?: string | null;
    failedNodeId?: string | null;
    stepCount: number;
    outputTruncated?: boolean;
    createdAt: string;
}

/** One run in full. */
export interface WorkflowRunDetail extends WorkflowRunRow {
    trace?: WorkflowRunTraceData | null;
    output?: unknown;
}

export interface WorkflowListResult<T> {
    items: T[];
    total: number;
}
