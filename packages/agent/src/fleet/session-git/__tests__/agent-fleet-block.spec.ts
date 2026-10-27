import { readAgentFleetBlock, writeAgentFleetBlock } from '../agent-fleet-block';

describe('agent.yml fleet block (FL-06 FR-13, FR-27)', () => {
    it('is optional: no file, no block, or not YAML reads as all defaults', () => {
        expect(readAgentFleetBlock(null)).toEqual({
            block: { branchPrefix: null, actions: {} },
            error: null,
        });
        expect(readAgentFleetBlock('name: nina\n')).toEqual({
            block: { branchPrefix: null, actions: {} },
            error: null,
        });
        expect(readAgentFleetBlock(': : not yaml [').error).toBeNull();
    });

    it('reads the prefix and the action overrides', () => {
        const { block, error } = readAgentFleetBlock(
            [
                'name: nina',
                'fleet:',
                '  branchPrefix: nina',
                '  actions:',
                "    commit: 'Commit {branch} in house style'",
            ].join('\n'),
        );
        expect(error).toBeNull();
        expect(block).toEqual({
            branchPrefix: 'nina',
            actions: { commit: 'Commit {branch} in house style' },
        });
    });

    it('refuses an unknown action id with the field named', () => {
        const { error } = readAgentFleetBlock(['fleet:', '  actions:', '    comit: x'].join('\n'));
        expect(error).toEqual(expect.objectContaining({ field: 'fleet.actions.comit' }));
    });

    it('refuses unknown keys in the block and a bad prefix', () => {
        expect(readAgentFleetBlock('fleet:\n  colour: red\n').error?.field).toBe('fleet.colour');
        expect(readAgentFleetBlock('fleet:\n  branchPrefix: "-rm"\n').error?.field).toBe(
            'fleet.branchPrefix',
        );
    });

    it('round-trips through the writer and keeps the rest of the file', () => {
        const original = ['# my agent', 'name: nina', 'model: x', ''].join('\n');
        const written = writeAgentFleetBlock(original, {
            branchPrefix: 'nina',
            actions: { recap: 'Recap for {task}' },
        });
        expect(written).not.toBeNull();
        expect(written).toContain('# my agent');
        expect(written).toContain('model: x');
        expect(readAgentFleetBlock(written).block).toEqual({
            branchPrefix: 'nina',
            actions: { recap: 'Recap for {task}' },
        });
        const cleared = writeAgentFleetBlock(written, { branchPrefix: null, actions: {} });
        expect(cleared).not.toContain('fleet');
        expect(cleared).toContain('model: x');
    });

    it('refuses to write into a file that is not YAML', () => {
        expect(
            writeAgentFleetBlock('key: [unclosed', { branchPrefix: 'x', actions: {} }),
        ).toBeNull();
    });
});
