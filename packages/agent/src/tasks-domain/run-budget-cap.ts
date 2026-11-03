import type { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { Mission } from '../entities/mission.entity';
import type { Task } from '../entities/task.entity';

/**
 * APW-08 T35 (APW08-G15) — a per-run cap is a positive whole number of cents; anything else is
 * no cap (never a zero cap that would stop every run before it starts).
 */
export function runBudgetCapCents(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/**
 * APW-08 T35 (FR-53, review of #3061) — the spend cap a run of this Task starts with: the
 * caller's explicit `maxBudgetCents` and, for a Task with a `missionId`, its Mission's
 * `guardrailsOverride.maxBudgetCentsPerRun`; the lower of the two when both are set, `null` when
 * neither is a positive whole number of cents.
 *
 * Resolved where a Task's run row is created (`TaskTransitionService.dispatchAgentRun`, the one
 * dispatch choke point, and the Task chat's mention runs), so the cap does not depend on which
 * surface started the run. The Mission is read by the Task's own `missionId`, which was checked
 * against the Task's owner when it was set. An unreadable Mission fails open to the explicit cap
 * (logged): the Agent's own budget still applies, and a broken read must not stop a run, the
 * same posture as the dispatch gate. Without a Missions repository, only the explicit cap counts.
 */
export async function resolveTaskRunBudgetCapCents(
    missionRows: Pick<Repository<Mission>, 'findOne'> | undefined,
    task: Pick<Task, 'id' | 'missionId'>,
    explicit: number | undefined,
    logger?: Pick<Logger, 'warn'>,
): Promise<number | null> {
    const own = runBudgetCapCents(explicit);
    if (!task.missionId || !missionRows) return own;
    let missionCap: number | null = null;
    try {
        const mission = await missionRows.findOne({
            where: { id: task.missionId },
            select: ['id', 'guardrailsOverride'],
        });
        const raw = mission?.guardrailsOverride?.maxBudgetCentsPerRun;
        missionCap = runBudgetCapCents(typeof raw === 'number' ? Math.trunc(raw) : raw);
    } catch (err) {
        logger?.warn(
            `Task ${task.id}: its Mission's per-run cap could not be read (${
                err instanceof Error ? err.message : String(err)
            }); the run starts without it.`,
        );
    }
    if (own === null) return missionCap;
    if (missionCap === null) return own;
    return Math.min(own, missionCap);
}
