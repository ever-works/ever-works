import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AiFacadeService } from '../facades/ai.facade';
import type {
    WorkflowDecision,
    WorkflowDecisionPort,
    WorkflowDecisionRequest,
} from './workflow-graph.ports';

/** What the model must return. Kept tiny so any provider can honour it. */
const decisionSchema = z.object({
    choice: z.string(),
    rationale: z.string().optional(),
});

/** Cap on the serialized node output handed to the model (prompt-size guard). */
export const WORKFLOW_DECISION_MAX_OUTPUT_CHARS = 4000;

function summarizeOutput(output: unknown): string {
    if (output === undefined || output === null) return '(no output)';
    let text: string;
    try {
        text = typeof output === 'string' ? output : JSON.stringify(output);
    } catch {
        return '(unserializable output)';
    }
    if (!text) return '(no output)';
    return text.length > WORKFLOW_DECISION_MAX_OUTPUT_CHARS
        ? `${text.slice(0, WORKFLOW_DECISION_MAX_OUTPUT_CHARS)}…(truncated)`
        : text;
}

/**
 * The production binding for `WORKFLOW_DECISION_PORT` (judgment layer G5).
 *
 * Turns the executor's `llm_decide` question into ONE `askJson` call on
 * the AI facade — never a raw provider SDK, so budget enforcement,
 * per-run cost attribution, provider override and the plugin seam all
 * apply exactly as they do for every other model call in the platform.
 *
 * The model is asked to return a `choice` token, not free prose, and the
 * executor still verifies the returned token against the graph's arms —
 * this adapter is a translator, not a trust boundary.
 */
@Injectable()
export class WorkflowAiDecisionAdapter implements WorkflowDecisionPort {
    private readonly logger = new Logger(WorkflowAiDecisionAdapter.name);

    constructor(private readonly ai: AiFacadeService) {}

    async decide(request: WorkflowDecisionRequest): Promise<WorkflowDecision> {
        const userId =
            typeof request.context.userId === 'string' ? request.context.userId : undefined;
        if (!userId) {
            // The facade is user-scoped (settings, budget, attribution). No
            // user ⇒ no legitimate call; fail LOUDLY so the executor can take
            // its declared fallback arm instead of a silent default branch.
            throw new Error('workflow llm_decide needs a userId in the run context');
        }

        const options = [
            'You are choosing the next step of a workflow.',
            `Step just completed: "${request.nodeId}".`,
            `Its output: ${summarizeOutput(request.nodeOutput)}`,
            '',
            'Choose EXACTLY ONE of these options and reply with its token:',
            ...request.choices.map(
                (choice) =>
                    `- ${choice.choice}${choice.description ? `: ${choice.description}` : ''}`,
            ),
            '',
            'Answer as JSON: { "choice": "<one of the tokens above>", "rationale": "<one short line>" }',
        ].join('\n');

        const facadeOptions: {
            userId: string;
            workId?: string;
            agentId?: string;
            taskId?: string;
            runId?: string;
        } = { userId };
        if (typeof request.context.workId === 'string')
            facadeOptions.workId = request.context.workId;
        if (typeof request.context.agentId === 'string')
            facadeOptions.agentId = request.context.agentId;
        if (typeof request.context.taskId === 'string')
            facadeOptions.taskId = request.context.taskId;
        if (typeof request.context.runId === 'string') facadeOptions.runId = request.context.runId;

        const response = await this.ai.askJson(
            options,
            decisionSchema,
            { temperature: 0 },
            facadeOptions,
        );

        const choice = response.result.choice?.trim();
        this.logger.log(
            `Workflow ${request.graphId}: node "${request.nodeId}" decided "${choice}" (${response.model}).`,
        );
        const decision: { choice: string; rationale?: string } = { choice: choice ?? '' };
        if (response.result.rationale) decision.rationale = response.result.rationale;
        return decision;
    }
}
