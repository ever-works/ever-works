import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Run orchestration — the DURABLE guard that every AgentRun dispatch
 * path stays behind `RunDispatchGateService`.
 *
 * The concurrency valve was consulted on the task fan-out and nowhere
 * else: chat replies, the heartbeat cron, run-now and
 * `POST /agents/:id/assign-task` all created runs and enqueued them
 * straight past it, so the limit held on one path and was decorative on
 * four. Fixing the four is a point-in-time repair; this spec is what
 * stops a FIFTH from landing unnoticed.
 *
 * Rule: every `createQueued(` call site is either
 *   - GATED   — a `dispatchGate` / `admit(` appears in its neighbourhood, or
 *   - BYPASS  — it carries the literal marker `DOCUMENTED dispatch-gate
 *               bypass`, which forces the author to say WHY in the same
 *               breath (see the worker-side trigger tasks: the runtime has
 *               already accepted that job, so the row is bookkeeping for
 *               work in flight, not a new admission).
 *
 * Anything else fails here, in a fast unit test, naming the file and line.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');

/** Package sources that may contain an AgentRun dispatch path. */
const SCAN_ROOTS = [
    join(REPO_ROOT, 'packages', 'agent', 'src'),
    join(REPO_ROOT, 'packages', 'tasks', 'src'),
    join(REPO_ROOT, 'apps', 'api', 'src'),
];

/** Lines of context searched around a call site for the gate. */
const CONTEXT_LINES = 30;

const BYPASS_MARKER = 'DOCUMENTED dispatch-gate bypass';
/**
 * Evidence that a call site sits behind the gate. `admit\w*` also covers
 * the thin per-path wrappers (e.g. the heartbeat dispatcher's
 * `admitHeartbeat`, which defers instead of parking).
 */
const GATE_HINTS = [/dispatchGate/, /\.admit\w*\s*\(/, /RunDispatchGate/];

interface CallSite {
    file: string;
    line: number;
    snippet: string;
    gated: boolean;
    documented: boolean;
}

function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue;
            walk(full, out);
            continue;
        }
        if (!entry.endsWith('.ts') || entry.endsWith('.d.ts') || entry.endsWith('.spec.ts')) {
            continue;
        }
        out.push(full);
    }
    return out;
}

/**
 * Locate every `createQueued(` call site and classify it. Exported so the
 * spec can exercise it against synthetic sources — a guard nobody has
 * seen fail is not a guard.
 */
export function classifyDispatchSites(source: string, file = '<memory>'): CallSite[] {
    const lines = source.split(/\r?\n/);
    const sites: CallSite[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (!/\.createQueued\s*\(/.test(lines[i])) continue;
        const from = Math.max(0, i - CONTEXT_LINES);
        const to = Math.min(lines.length, i + CONTEXT_LINES);
        const context = lines.slice(from, to).join('\n');
        sites.push({
            file,
            line: i + 1,
            snippet: lines[i].trim(),
            gated: GATE_HINTS.some((hint) => hint.test(context)),
            documented: context.includes(BYPASS_MARKER),
        });
    }
    return sites;
}

describe('every AgentRun dispatch path is gated or documented', () => {
    const files = SCAN_ROOTS.flatMap((root) => walk(root));

    const allSites: CallSite[] = files.flatMap((file) =>
        classifyDispatchSites(
            readFileSync(file, 'utf8'),
            relative(REPO_ROOT, file).split(sep).join('/'),
        ),
    );
    // The repository's own definition of `createQueued` is not a call site.
    const callSites = allSites.filter(
        (s) => !s.file.endsWith('database/repositories/agent-run.repository.ts'),
    );

    it('finds the dispatch call sites to check (a scan over zero files proves nothing)', () => {
        expect(files.length).toBeGreaterThan(100);
        expect(callSites.length).toBeGreaterThanOrEqual(6);
    });

    it('NO call site is both ungated and undocumented', () => {
        const offenders = callSites
            .filter((s) => !s.gated && !s.documented)
            .map((s) => `${s.file}:${s.line}  ${s.snippet}`);
        expect(offenders).toEqual([]);
    });

    it.each([
        ['packages/agent/src/tasks-domain/task-transition.service.ts', 'task fan-out + board run'],
        ['packages/agent/src/tasks-domain/task-chat.service.ts', 'agent-mention chat reply'],
        ['packages/agent/src/agents/run-steering.service.ts', 'resume'],
        ['apps/api/src/agents/agents.controller.ts', 'assign-task endpoint'],
    ])('%s (%s) dispatches through the gate', (file) => {
        const sites = callSites.filter((s) => s.file === file);
        expect(sites.length).toBeGreaterThan(0);
        for (const site of sites) {
            expect({ file: site.file, line: site.line, gated: site.gated }).toEqual({
                file: site.file,
                line: site.line,
                gated: true,
            });
        }
    });

    it.each([
        'packages/tasks/src/tasks/trigger/agent-task-execute.task.ts',
        'packages/tasks/src/tasks/trigger/agent-chat-reply.task.ts',
        'packages/tasks/src/tasks/trigger/agent-heartbeat.task.ts',
    ])('%s stays a DOCUMENTED bypass (worker-side, job already accepted)', (file) => {
        const sites = callSites.filter((s) => s.file === file);
        expect(sites.length).toBeGreaterThan(0);
        for (const site of sites) {
            expect(site.documented).toBe(true);
        }
    });

    it('the heartbeat dispatcher gates without creating a row when refused', () => {
        // `AgentScheduleDispatcherService` defers rather than parks, so its
        // gate call has no `reserve` callback — but it MUST still be gated.
        const source = readFileSync(
            join(REPO_ROOT, 'packages/agent/src/agents/agent-schedule-dispatcher.service.ts'),
            'utf8',
        );
        const sites = classifyDispatchSites(source, 'agent-schedule-dispatcher.service.ts');
        expect(sites.length).toBe(2); // dispatchDue + dispatchOne
        for (const site of sites) {
            expect(site.gated).toBe(true);
        }
    });

    describe('the classifier itself', () => {
        it('CATCHES an ungated, undocumented dispatch', () => {
            const bad = [
                'async function rogueDispatch() {',
                '    const run = await this.runs.createQueued({ agentId, userId });',
                '    await dispatcher.enqueue({ runId: run.id });',
                '}',
            ].join('\n');
            const sites = classifyDispatchSites(bad);
            expect(sites).toHaveLength(1);
            expect(sites[0].gated).toBe(false);
            expect(sites[0].documented).toBe(false);
        });

        it('ACCEPTS a gated dispatch', () => {
            const good = [
                'const admission = await this.dispatchGate.admit(input, reserve);',
                'const run = await this.runs.createQueued({ agentId, userId });',
            ].join('\n');
            expect(classifyDispatchSites(good)[0].gated).toBe(true);
        });

        it('ACCEPTS a documented bypass', () => {
            const good = [
                '// DOCUMENTED dispatch-gate bypass: the runtime already accepted this job.',
                'run = await runs.createQueued({ agentId, userId, triggerKind: "task" });',
            ].join('\n');
            const site = classifyDispatchSites(good)[0];
            expect(site.gated).toBe(false);
            expect(site.documented).toBe(true);
        });

        it('ACCEPTS a thin per-path admission wrapper (e.g. `admitHeartbeat`)', () => {
            const good = [
                'if (!(await this.admitHeartbeat(agent))) continue;',
                'const run = await this.agentRunRepository.createQueued({ agentId });',
            ].join('\n');
            expect(classifyDispatchSites(good)[0].gated).toBe(true);
        });

        it('does NOT reach past its context window for the gate', () => {
            const far = [
                'await this.someGate.admit(input);',
                ...Array.from({ length: CONTEXT_LINES + 5 }, () => '// filler'),
                'const run = await this.runs.createQueued({ agentId });',
            ].join('\n');
            expect(classifyDispatchSites(far)[0].gated).toBe(false);
        });
    });
});
