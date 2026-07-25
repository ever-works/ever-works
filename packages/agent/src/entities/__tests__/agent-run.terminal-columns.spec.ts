import { getMetadataArgsStorage } from 'typeorm';
import { AgentRun } from '../agent-run.entity';

/**
 * Streaming-terminal M4 — schema invariant ("Gate J").
 *
 * `agent_runs` must NEVER grow content/transcript/byte columns:
 * terminal output lives ONLY in coalesced log chunks and the relay's
 * in-memory window. A column that smells like payload storage here is
 * a design regression (unbounded row growth + a second, unredacted
 * copy of terminal bytes), so the test fails on NAME — the reviewer
 * has to consciously delete this pin to break the invariant.
 */
describe('AgentRun terminal columns — schema invariants', () => {
    const columns = getMetadataArgsStorage()
        .columns.filter((c) => c.target === AgentRun)
        .map((c) => c.propertyName);

    it('has the M4 terminal lifecycle columns', () => {
        for (const expected of [
            'persistent',
            'terminalState',
            'terminalEndedReason',
            'terminalProviderId',
            'cliSessionId',
            'lastHeartbeatAt',
            'lastFrameSeq',
        ]) {
            expect(columns).toContain(expected);
        }
    });

    it('NEVER stores terminal content on the run row', () => {
        const forbidden = /transcript|scrollback|stdout|stderr|bytes|content|buffer|output/i;
        const offenders = columns.filter((name) => forbidden.test(name));
        expect(offenders).toEqual([]);
    });
});
