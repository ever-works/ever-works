'use client';

import { useState, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
// Runtime values come from the CLIENT-SAFE module. `@/lib/api/goals` starts
// with `import 'server-only'`, so a value import from it drags that module into
// the client bundle and the Next build fails outright. Type-only imports are
// erased at compile time and stay safe to take from the barrel.
import { GOAL_EXECUTION_TARGETS } from '@/lib/api/goals.shared';
import { type Goal, type GoalExecutionTarget, type UpdateGoalLimitsInput } from '@/lib/api/goals';
import { updateGoalLimitsAction } from './actions';

/**
 * The minimum an Agent has to be to appear in the routing pin. Deliberately
 * NOT the full `Agent` type: this dialog is a client component and the whole
 * Agent projection would ride the server→client boundary for two fields.
 */
export interface GoalAgentOption {
    id: string;
    name: string;
}

interface GoalLimitsDialogProps {
    goal: Goal;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onGoalChange: (goal: Goal) => void;
    /** Agents the operator may pin routing to. Empty = no pin control. */
    agents?: GoalAgentOption[];
}

/**
 * Empty input → `null` (CLEAR the ceiling), a number → that number.
 *
 * This is the whole reason the form keeps strings in state rather than
 * numbers: `0` and "cleared" are different intents, and a numeric state
 * that coerces `''` to `0` would silently turn "remove this cap" into
 * "set the cap to zero" — which would stop the loop forever.
 */
function toNullableInt(value: string): number | null | undefined {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.round(parsed);
}

function toNullableText(value: string): string | null {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
}

/**
 * Autonomy layer — the "Adjust limits" surface.
 *
 * Spend is entered in DOLLARS because that is what an operator thinks in,
 * and converted to cents exactly once here; the API and the database
 * speak cents end to end so the ceiling can never drift by rounding.
 */
export function GoalLimitsDialog({
    goal,
    open,
    onOpenChange,
    onGoalChange,
    agents = [],
}: GoalLimitsDialogProps) {
    const t = useTranslations('dashboard.goalDetail.limits');
    const [pending, startTransition] = useTransition();

    const [spendCapUsd, setSpendCapUsd] = useState(
        goal.spendCapCents === null ? '' : String(goal.spendCapCents / 100),
    );
    const [wallClock, setWallClock] = useState(
        goal.wallClockLimitHours === null ? '' : String(goal.wallClockLimitHours),
    );
    const [stuckThreshold, setStuckThreshold] = useState(
        goal.stuckThresholdIterations === null ? '' : String(goal.stuckThresholdIterations),
    );
    const [maxConcurrentIterations, setMaxConcurrentIterations] = useState(
        goal.maxConcurrentIterations === null || goal.maxConcurrentIterations === undefined
            ? ''
            : String(goal.maxConcurrentIterations),
    );
    const [sessionBudget, setSessionBudget] = useState(
        goal.sessionBudgetMinutes === null ? '' : String(goal.sessionBudgetMinutes),
    );
    const [grace, setGrace] = useState(
        goal.gracePeriodMinutes === null ? '' : String(goal.gracePeriodMinutes),
    );
    const [executionTarget, setExecutionTarget] = useState<string>(goal.executionTarget ?? '');
    const [plannerModel, setPlannerModel] = useState(goal.plannerModelHint ?? '');
    const [workerModel, setWorkerModel] = useState(goal.workerModelHint ?? '');
    const [assignedAgent, setAssignedAgent] = useState<string>(goal.assignedAgentId ?? '');

    const submit = () => {
        const spendDollars = spendCapUsd.trim();
        let spendCapCents: number | null | undefined;
        if (spendDollars === '') {
            spendCapCents = null;
        } else {
            const parsed = Number(spendDollars);
            if (!Number.isFinite(parsed) || parsed < 0) {
                toast.error(t('errors.spendCap'));
                return;
            }
            spendCapCents = Math.round(parsed * 100);
        }

        const input: UpdateGoalLimitsInput = {
            spendCapCents,
            wallClockLimitHours: toNullableInt(wallClock),
            stuckThresholdIterations: toNullableInt(stuckThreshold),
            maxConcurrentIterations: toNullableInt(maxConcurrentIterations),
            sessionBudgetMinutes: toNullableInt(sessionBudget),
            gracePeriodMinutes: toNullableInt(grace),
            executionTarget:
                executionTarget === '' ? null : (executionTarget as GoalExecutionTarget),
            plannerModelHint: toNullableText(plannerModel),
            workerModelHint: toNullableText(workerModel),
            // `null` unpins and restores round-robin over the Goal's history,
            // which is why this is sent even when empty: omitting it would
            // make the pin one-way.
            assignedAgentId: assignedAgent === '' ? null : assignedAgent,
        };

        startTransition(async () => {
            try {
                onGoalChange(await updateGoalLimitsAction(goal.id, input));
                toast.success(t('toasts.saved'));
                onOpenChange(false);
            } catch (err) {
                toast.error(err instanceof Error ? err.message : t('toasts.error'));
            }
        });
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t('title')}</DialogTitle>
                    <DialogDescription>{t('description')}</DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 @lg/main:grid-cols-2">
                    {agents.length > 0 ? (
                        <div className="@lg/main:col-span-2">
                            <label className="mb-1 block text-xs font-medium text-text dark:text-text-dark">
                                {t('fields.assignedAgent')}
                            </label>
                            <Select
                                value={assignedAgent}
                                onValueChange={setAssignedAgent}
                                placeholder={t('fields.assignedAgentNone')}
                            >
                                <option value="">{t('fields.assignedAgentNone')}</option>
                                {agents.map((agent) => (
                                    <option key={agent.id} value={agent.id}>
                                        {agent.name}
                                    </option>
                                ))}
                            </Select>
                            <p className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                                {t('fields.assignedAgentHelp')}
                            </p>
                        </div>
                    ) : null}
                    <Input
                        label={t('fields.spendCap')}
                        helperText={t('fields.spendCapHelp')}
                        type="number"
                        min={0}
                        step="0.01"
                        value={spendCapUsd}
                        onChange={(e) => setSpendCapUsd(e.target.value)}
                    />
                    <Input
                        label={t('fields.wallClock')}
                        helperText={t('fields.wallClockHelp')}
                        type="number"
                        min={1}
                        value={wallClock}
                        onChange={(e) => setWallClock(e.target.value)}
                    />
                    <Input
                        label={t('fields.stuckThreshold')}
                        helperText={t('fields.stuckThresholdHelp')}
                        type="number"
                        min={1}
                        value={stuckThreshold}
                        onChange={(e) => setStuckThreshold(e.target.value)}
                    />
                    {/* Concurrent iterations (slice AH). Empty = one at a
                        time, which is what every Goal did before and what
                        `toNullableInt` sends as `null`. */}
                    <Input
                        label={t('fields.maxConcurrentIterations')}
                        helperText={t('fields.maxConcurrentIterationsHelp')}
                        type="number"
                        min={1}
                        max={10}
                        value={maxConcurrentIterations}
                        onChange={(e) => setMaxConcurrentIterations(e.target.value)}
                    />
                    <Input
                        label={t('fields.sessionBudget')}
                        helperText={t('fields.sessionBudgetHelp')}
                        type="number"
                        min={1}
                        value={sessionBudget}
                        onChange={(e) => setSessionBudget(e.target.value)}
                    />
                    <Input
                        label={t('fields.gracePeriod')}
                        helperText={t('fields.gracePeriodHelp')}
                        type="number"
                        min={0}
                        value={grace}
                        onChange={(e) => setGrace(e.target.value)}
                    />
                    <div>
                        <label className="mb-1 block text-xs font-medium text-text dark:text-text-dark">
                            {t('fields.executionTarget')}
                        </label>
                        <Select
                            value={executionTarget}
                            onValueChange={setExecutionTarget}
                            placeholder={t('fields.executionTargetDefault')}
                        >
                            <option value="">{t('fields.executionTargetDefault')}</option>
                            {GOAL_EXECUTION_TARGETS.map((target) => (
                                <option key={target} value={target}>
                                    {t(`executionTargets.${target}`)}
                                </option>
                            ))}
                        </Select>
                        <p className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark">
                            {t('fields.executionTargetHelp')}
                        </p>
                    </div>
                    <Input
                        label={t('fields.plannerModel')}
                        helperText={t('fields.plannerModelHelp')}
                        value={plannerModel}
                        onChange={(e) => setPlannerModel(e.target.value)}
                    />
                    <Input
                        label={t('fields.workerModel')}
                        helperText={t('fields.workerModelHelp')}
                        value={workerModel}
                        onChange={(e) => setWorkerModel(e.target.value)}
                    />
                </div>

                <p className="mt-3 text-[11px] text-text-muted dark:text-text-muted-dark">
                    {t('clearHint')}
                </p>

                <DialogFooter>
                    <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                        {t('cancel')}
                    </Button>
                    <Button size="sm" loading={pending} disabled={pending} onClick={submit}>
                        {t('save')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
