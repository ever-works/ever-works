import { ConflictException } from '@nestjs/common';
import { TaskTransitionService } from '../task-transition.service';
import { TaskStatus, TaskPriority } from '../../entities/task.entity';
import type { Task } from '../../entities/task.entity';

/**
 * Quality gates (Wave 3 M8) — agent-driven transition gate.
 *
 * The rule under test: an AGENT-driven `in_progress → in_review` is refused
 * (409) when the Task's Work has `checksPolicy: 'required'` AND the Task's
 * latest AgentRun carries a non-passing gate verdict ('red' — required
 * checks failed; or 'skipped' — the required policy found zero checks, and
 * a gate that did not run must never pass anything). Everything else is
 * untouched: human transitions, warn/off policies, green/absent verdicts,
 * other edges, and `force` (policy override, same semantics as the
 * approver-gate force).
 */
function makeTask(over: Partial<Task> = {}): Task {
    return {
        id: 't1',
        userId: 'u1',
        slug: 'T-1',
        title: 'Ship the feature',
        description: null,
        status: TaskStatus.IN_PROGRESS,
        previousStatus: null,
        priority: TaskPriority.P3,
        labels: null,
        missionId: null,
        ideaId: null,
        workId: 'w1',
        parentTaskId: null,
        createdByType: 'user',
        createdById: 'u1',
        requireAllApprovers: false,
        startedAt: new Date('2026-01-01'),
        completedAt: null,
        isRecurring: false,
        recurrenceOccurredCount: 0,
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
        ...over,
    } as Task;
}

describe('TaskTransitionService — quality-gate review-entry rule (Wave 3 M8)', () => {
    let tasks: any;
    let blocks: any;
    let approvers: any;
    let runs: any;
    let works: any;

    beforeEach(() => {
        tasks = {
            casUpdateStatus: jest.fn().mockResolvedValue(true),
            findById: jest.fn(),
        };
        blocks = { findByTaskId: jest.fn().mockResolvedValue([]) };
        approvers = { allApproved: jest.fn().mockResolvedValue(true) };
        runs = {
            findLatestForTask: jest.fn().mockResolvedValue(null),
        };
        works = { findById: jest.fn().mockResolvedValue(null) };
    });

    /** Positional construction mirrors the sibling specs; the gate deps
     *  (`runs` in slot 5, `works` appended LAST) are the ones that matter. */
    function makeSvc() {
        return new TaskTransitionService(
            tasks,
            blocks,
            approvers,
            undefined, // assignees
            runs,
            undefined, // dispatcher
            undefined, // notifications
            undefined, // runDenorm
            undefined, // dispatchGate
            works,
        );
    }

    /** Point the fixtures at a required-policy Work + a latest-run verdict. */
    function givenGate(policy: string | null, gateStatus: string | null) {
        works.findById.mockResolvedValue(policy ? { id: 'w1', checksPolicy: policy } : null);
        runs.findLatestForTask.mockResolvedValue(
            gateStatus === null ? null : { id: 'r1', taskId: 't1', gateStatus },
        );
    }

    function expectAllowed(task: Task, to: TaskStatus, opts?: any) {
        tasks.findById.mockResolvedValueOnce({ ...task, status: to });
        return new Promise<void>((resolve, reject) => {
            makeSvc()
                .transition(task, to, opts)
                .then((row) => {
                    expect(row.status).toBe(to);
                    resolve();
                })
                .catch(reject);
        });
    }

    // ── The refusal half of the matrix ───────────────────────────────

    it('AGENT-driven in_progress → in_review is refused on a RED gate under required policy', async () => {
        givenGate('required', 'red');
        await expect(
            makeSvc().transition(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'agent' }),
        ).rejects.toThrow(ConflictException);
        // Refused BEFORE the status write — the CAS must never land.
        expect(tasks.casUpdateStatus).not.toHaveBeenCalled();
    });

    it("the refusal names the verdict and the override ('red' + force=true hint)", async () => {
        givenGate('required', 'red');
        await expect(
            makeSvc().transition(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'agent' }),
        ).rejects.toThrow(/quality gate is 'red'.*force=true/);
    });

    it('AGENT-driven in_progress → in_review is refused on a SKIPPED gate (skipped is never a pass)', async () => {
        givenGate('required', 'skipped');
        await expect(
            makeSvc().transition(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'agent' }),
        ).rejects.toThrow(ConflictException);
    });

    // ── The allowed half of the matrix ───────────────────────────────

    it('AGENT-driven in_progress → in_review proceeds on a GREEN gate', async () => {
        givenGate('required', 'green');
        await expectAllowed(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'agent' });
        expect(tasks.casUpdateStatus).toHaveBeenCalledTimes(1);
    });

    it('HUMAN in_progress → in_review proceeds even on a RED gate (no actorType)', async () => {
        givenGate('required', 'red');
        await expectAllowed(makeTask(), TaskStatus.IN_REVIEW);
        // The rule must not even consult the gate for a human move.
        expect(works.findById).not.toHaveBeenCalled();
        expect(runs.findLatestForTask).not.toHaveBeenCalled();
    });

    it("HUMAN in_progress → in_review proceeds on a RED gate (explicit actorType 'user')", async () => {
        givenGate('required', 'red');
        await expectAllowed(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'user' });
        expect(works.findById).not.toHaveBeenCalled();
    });

    it('force=true overrides the gate for an AGENT-driven move (policy override, like the approver gate)', async () => {
        givenGate('required', 'red');
        await expectAllowed(makeTask(), TaskStatus.IN_REVIEW, {
            actorType: 'agent',
            force: true,
        });
        expect(works.findById).not.toHaveBeenCalled();
    });

    it("a 'warn' checks policy never refuses, even agent-driven on red", async () => {
        givenGate('warn', 'red');
        await expectAllowed(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'agent' });
    });

    // ── Fail-toward-status-quo edges ─────────────────────────────────

    it('no latest run → allowed (a rule without evidence must not block)', async () => {
        givenGate('required', null);
        await expectAllowed(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'agent' });
    });

    it('latest run without a gate verdict (gateStatus null) → allowed', async () => {
        givenGate('required', null);
        runs.findLatestForTask.mockResolvedValue({ id: 'r1', taskId: 't1', gateStatus: null });
        await expectAllowed(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'agent' });
    });

    it('Task without a Work → allowed without any lookup', async () => {
        givenGate('required', 'red');
        await expectAllowed(makeTask({ workId: null }), TaskStatus.IN_REVIEW, {
            actorType: 'agent',
        });
        expect(works.findById).not.toHaveBeenCalled();
        expect(runs.findLatestForTask).not.toHaveBeenCalled();
    });

    it('Work lookup failure → allowed (never invent a blocking verdict from a hiccup)', async () => {
        works.findById.mockRejectedValue(new Error('DB down'));
        runs.findLatestForTask.mockResolvedValue({ id: 'r1', gateStatus: 'red' });
        await expectAllowed(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'agent' });
    });

    it('latest-run lookup failure → allowed', async () => {
        givenGate('required', 'red');
        runs.findLatestForTask.mockRejectedValue(new Error('DB down'));
        await expectAllowed(makeTask(), TaskStatus.IN_REVIEW, { actorType: 'agent' });
    });

    it('the rule is scoped to the review-entry edge: agent-driven in_progress → blocked passes on red', async () => {
        givenGate('required', 'red');
        await expectAllowed(makeTask(), TaskStatus.BLOCKED, { actorType: 'agent' });
        expect(works.findById).not.toHaveBeenCalled();
    });

    it('fixtures without the gate deps (older positional construction) skip the rule entirely', async () => {
        // The exact constructor call every pre-M8 spec uses.
        const svc = new TaskTransitionService(tasks, blocks, approvers);
        const task = makeTask();
        tasks.findById.mockResolvedValueOnce({ ...task, status: TaskStatus.IN_REVIEW });
        const row = await svc.transition(task, TaskStatus.IN_REVIEW, { actorType: 'agent' });
        expect(row.status).toBe(TaskStatus.IN_REVIEW);
    });
});
