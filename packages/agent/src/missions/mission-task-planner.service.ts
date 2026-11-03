import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AiFacadeService } from '../facades/ai.facade';
import { fenceUntrusted } from '../utils/untrusted-content';

/**
 * APW-08 T35 (FR-51) — proposes the Tasks a Mission files on one of its App Works.
 *
 * The inputs are the Mission's description (the owner's own words), the App Work's name and
 * description, the titles of its most recent Tasks and the relation: **Improves** asks for
 * product changes, **Operates** for maintenance (dependency updates, failed deliveries, upstream
 * conflicts). Everything that did not come from the Mission's owner — the Work's description and
 * the Task titles, which agents and imports write — is fenced as untrusted data, so a Task title
 * that reads like an instruction stays data.
 *
 * The answer is schema-checked (`{ tasks: [{ title ≤ 120, description ≤ 4000 }] }`) and cut to
 * the count asked for. The caller drops a proposal whose normalised title equals an open Task's.
 */

/** FR-51 — the Work's most recent Task titles the planner sees. */
export const MISSION_PLANNER_RECENT_TASKS = 20;

const PLANNED_TASK_SCHEMA = z.object({
    tasks: z
        .array(
            z.object({
                title: z.string().min(1).max(120),
                description: z.string().max(4000).optional().default(''),
            }),
        )
        .max(10),
});

export interface MissionTaskPlanInput {
    userId: string;
    missionId: string;
    missionDescription: string;
    relation: 'improves' | 'operates';
    work: { id: string; name: string; description?: string | null };
    recentTaskTitles: readonly string[];
    /** How many Tasks to propose (1..3, the Mission's `tasksPerTick` within its open cap). */
    count: number;
}

export interface PlannedMissionTask {
    title: string;
    description: string;
}

/** The planner's prompt — pure, so the fencing is testable without a model. */
export function buildMissionTaskPrompt(input: MissionTaskPlanInput): string {
    const ask =
        input.relation === 'operates'
            ? 'maintenance work that keeps it healthy: dependency updates, fixing failed deliveries, resolving upstream conflicts'
            : 'product changes that move it toward the Mission';
    const count = Math.max(1, Math.min(3, Math.trunc(input.count)));
    return [
        `You plan work for one app. Propose at most ${count} Task${count === 1 ? '' : 's'}: ${ask}.`,
        'Each Task is one change a coding agent can make in a single pull request.',
        'Give each a short imperative title (at most 120 characters) and a description of what done looks like.',
        "Do not repeat a Task that is already in the app's recent Tasks.",
        'Answer as JSON: {"tasks":[{"title":"…","description":"…"}]}.',
        '',
        "The Mission (the owner's own words):",
        input.missionDescription.trim().slice(0, 4000),
        '',
        `The app: ${input.work.name.trim().slice(0, 200)}`,
        fenceUntrusted('app_description', input.work.description ?? '', {
            source: "the app's description",
            maxChars: 2000,
        }),
        '',
        fenceUntrusted(
            'recent_task_titles',
            input.recentTaskTitles
                .slice(0, MISSION_PLANNER_RECENT_TASKS)
                .map((title) => `- ${title}`)
                .join('\n'),
            { source: "the app's most recent Task titles", maxChars: 6000 },
        ),
    ].join('\n');
}

@Injectable()
export class MissionTaskPlannerService {
    constructor(private readonly ai: AiFacadeService) {}

    async plan(input: MissionTaskPlanInput): Promise<PlannedMissionTask[]> {
        const count = Math.max(1, Math.min(3, Math.trunc(input.count)));
        const response = await this.ai.askJson(
            buildMissionTaskPrompt({ ...input, count }),
            PLANNED_TASK_SCHEMA,
            { temperature: 0.2 },
            { userId: input.userId, workId: input.work.id },
        );
        return response.result.tasks
            .map((task) => ({
                title: task.title.trim().slice(0, 120),
                description: (task.description ?? '').trim().slice(0, 4000),
            }))
            .filter((task) => task.title.length > 0)
            .slice(0, count);
    }
}

/** FR-51 — titles compared case-, space- and punctuation-insensitively. */
export function normalizeTaskTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}
