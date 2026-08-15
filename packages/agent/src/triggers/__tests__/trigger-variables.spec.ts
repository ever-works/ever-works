import {
    MAX_DEFAULT_VARIABLES,
    TriggerVariablesError,
    describeMissingVariables,
    findMissingRequiredVariables,
    normalizeDefaultVariables,
} from '../trigger-variables';

describe('normalizeDefaultVariables', () => {
    it('canonicalizes entries and defaults `required` to false', () => {
        expect(
            normalizeDefaultVariables([
                { key: ' repo ', required: true },
                { key: 'branch', label: '  Branch  ' },
            ]),
        ).toEqual([
            { key: 'repo', required: true },
            { key: 'branch', required: false, label: 'Branch' },
        ]);
    });

    it('treats null/undefined/empty as "no contract"', () => {
        expect(normalizeDefaultVariables(null)).toBeNull();
        expect(normalizeDefaultVariables(undefined)).toBeNull();
        expect(normalizeDefaultVariables([])).toBeNull();
    });

    it('rejects malformed keys, duplicates, over-long labels and oversized lists', () => {
        expect(() => normalizeDefaultVariables([{ key: 'not a key' }])).toThrow(
            TriggerVariablesError,
        );
        expect(() => normalizeDefaultVariables([{ key: '' }])).toThrow(TriggerVariablesError);
        expect(() => normalizeDefaultVariables([{ key: 'a' }, { key: 'a' }])).toThrow(
            TriggerVariablesError,
        );
        expect(() => normalizeDefaultVariables([{ key: 'a', label: 'x'.repeat(200) }])).toThrow(
            TriggerVariablesError,
        );
        expect(() =>
            normalizeDefaultVariables(
                Array.from({ length: MAX_DEFAULT_VARIABLES + 1 }, (_, i) => ({ key: `k${i}` })),
            ),
        ).toThrow(TriggerVariablesError);
    });
});

describe('findMissingRequiredVariables', () => {
    const contract = [
        { key: 'repo', required: true },
        { key: 'branch', required: true },
        { key: 'note', required: false },
    ];

    it('reports only required keys, in declaration order', () => {
        expect(findMissingRequiredVariables(contract, {})).toEqual(['repo', 'branch']);
        expect(findMissingRequiredVariables(contract, { repo: 'a' })).toEqual(['branch']);
        expect(findMissingRequiredVariables(contract, { repo: 'a', branch: 'main' })).toEqual([]);
    });

    it('counts null, undefined and blank strings as missing — but 0 and false as present', () => {
        expect(findMissingRequiredVariables(contract, { repo: null, branch: '   ' })).toEqual([
            'repo',
            'branch',
        ]);
        expect(
            findMissingRequiredVariables(
                [
                    { key: 'count', required: true },
                    { key: 'flag', required: true },
                ],
                { count: 0, flag: false },
            ),
        ).toEqual([]);
    });

    it('never satisfies a key through the prototype chain', () => {
        expect(findMissingRequiredVariables([{ key: 'constructor', required: true }], {})).toEqual([
            'constructor',
        ]);
    });

    it('is a no-op without a declared contract', () => {
        expect(findMissingRequiredVariables(null, {})).toEqual([]);
        expect(findMissingRequiredVariables([], { any: 1 })).toEqual([]);
    });
});

describe('describeMissingVariables', () => {
    it('names the keys and nothing else', () => {
        expect(describeMissingVariables(['repo', 'branch'])).toBe(
            'Missing required payload variable(s): repo, branch.',
        );
    });
});
