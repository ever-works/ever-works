import type { FleetJobView } from '@ever-works/contracts';

/** The platform identities an `agent-task` fleet job carries. */
export interface FleetAgentTaskCorrelation {
    runId: string;
    taskId: string;
    agentId: string | null;
}

/**
 * Job → (run, task, agent) correlation for an `agent-task` fleet job, or
 * null for any other job (or a malformed payload).
 *
 * A leaf so the panic controls (cancel-in-flight) and the reconciler
 * read a job's identities through ONE function without the panic
 * service importing the reconciler's whole dependency graph.
 * `FleetAgentTaskReconcilerService.correlate` delegates here.
 */
export function correlateAgentTaskJob(job: FleetJobView): FleetAgentTaskCorrelation | null {
    if (job.kind !== 'agent-task') return null;
    const payload = job.payload;
    if (!payload || typeof payload !== 'object') return null;
    const runId = typeof payload.runId === 'string' ? payload.runId.trim() : '';
    const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    if (!runId || !taskId) return null;
    const agentId =
        typeof payload.agentId === 'string' && payload.agentId.trim()
            ? payload.agentId.trim()
            : null;
    return { runId, taskId, agentId };
}
