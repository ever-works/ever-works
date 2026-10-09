import { fleetModelTimelineLogRows } from '../fleet-run-evidence';

/**
 * Self-build slice AP — the platform side of the run timeline.
 *
 * Review round 2 (CodeRabbit risk note): the platform's own secret scanner
 * must see the node's FULL strings, before the contract's caps cut them —
 * a token straddling a cap reaches the scanner as a fragment its patterns
 * no longer match, and that fragment would be stored.
 */
describe('fleetModelTimelineLogRows', () => {
    const TOKEN = `ghp_${'A1b2C3d4E5'.repeat(4)}`;

    it('scans an argument summary at full length, before the contract cap cuts the token', () => {
        // The token starts at char 180 of a 250-char summary; the contract
        // caps a summary at 200 chars, which would leave `ghp_` + 15 chars.
        const argsSummary = `command=${'z'.repeat(171)} ${TOKEN} ${'q'.repeat(25)}`;
        const rows = fleetModelTimelineLogRows({
            model: {
                timeline: [
                    { kind: 'tool-call', atMs: 1, toolName: 'Bash', argsSummary, status: 'ok' },
                ],
            },
        });
        const preview = String(rows[0].metadata.argsPreview);
        expect(preview).not.toContain('ghp_');
        expect(preview).toContain('[redacted secret]');
    });

    it('does the same for a message text past its cap', () => {
        const text = `${'w '.repeat(495)}${TOKEN} and more text after it`;
        const rows = fleetModelTimelineLogRows({
            model: { timeline: [{ kind: 'assistant-message', atMs: 1, text }] },
        });
        expect(rows[0].message).not.toContain('ghp_');
    });

    it('writes nothing for a result with no model or no timeline', () => {
        expect(fleetModelTimelineLogRows(null)).toEqual([]);
        expect(fleetModelTimelineLogRows({ model: { summary: 'x' } })).toEqual([]);
    });
});
