import {
    EVER_ID_TRUSTED_CLIENT_IDS_ENV,
    EVER_ID_TRUSTED_CLIENT_IDS_MAX,
    parseTrustedClientIds,
    resolveTrustedClientIds,
} from './ever-id-trusted-clients';

/**
 * `EVER_ID_TRUSTED_CLIENT_IDS` — the optional narrowing of the delegated read to tokens minted
 * for named clients. The direction that matters most is the default: unset (or rendered empty
 * by a deploy manifest) must keep today's behaviour exactly, and a value that was set must never
 * quietly turn into "no rule".
 */

function env(value: string | undefined, nodeEnv = 'development'): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { NODE_ENV: nodeEnv };
    if (value !== undefined) out[EVER_ID_TRUSTED_CLIENT_IDS_ENV] = value;
    return out;
}

describe('parseTrustedClientIds', () => {
    it('splits on commas, trims, drops empty entries and keeps the order written', () => {
        expect(parseTrustedClientIds(' app-ever-co , 339462828377423874@ever ,,')).toEqual({
            clientIds: ['app-ever-co', '339462828377423874@ever'],
            invalid: [],
            tooMany: false,
        });
    });

    it('de-duplicates exact spellings only, because the provider compares exactly', () => {
        expect(parseTrustedClientIds('a,a,A').clientIds).toEqual(['a', 'A']);
    });

    it('classifies an entry with a space or a control character as invalid', () => {
        expect(parseTrustedClientIds('good,has space,tab\there').invalid).toEqual([
            'has space',
            'tab\there',
        ]);
    });

    it('flags more than the ceiling', () => {
        const six = Array.from({ length: EVER_ID_TRUSTED_CLIENT_IDS_MAX + 1 }, (_, i) => `c${i}`);
        expect(EVER_ID_TRUSTED_CLIENT_IDS_MAX).toBe(5);
        expect(parseTrustedClientIds(six.join(',')).tooMany).toBe(true);
        expect(parseTrustedClientIds(six.slice(0, 5).join(',')).tooMany).toBe(false);
    });
});

describe('resolveTrustedClientIds', () => {
    it('answers undefined (no rule, today’s behaviour) when unset, empty or only separators', () => {
        expect(resolveTrustedClientIds(env(undefined))).toBeUndefined();
        expect(resolveTrustedClientIds(env(''))).toBeUndefined();
        expect(resolveTrustedClientIds(env(' , '))).toBeUndefined();
        expect(resolveTrustedClientIds(env('', 'production'))).toBeUndefined();
    });

    it('answers the list, frozen, when it is valid', () => {
        const list = resolveTrustedClientIds(env('app-ever-co,launcher-2', 'production'));
        expect(list).toEqual(['app-ever-co', 'launcher-2']);
        expect(Object.isFrozen(list)).toBe(true);
    });

    it('stops a production boot on an invalid entry or too many entries', () => {
        expect(() => resolveTrustedClientIds(env('good,bad entry', 'production'))).toThrow(
            /EVER_ID_TRUSTED_CLIENT_IDS carries 1 entry/,
        );
        expect(() => resolveTrustedClientIds(env('a,b,c,d,e,f', 'production'))).toThrow(
            /maximum is 5/,
        );
    });

    it('outside production drops invalid entries and truncates, with the valid rest still enforced', () => {
        expect(resolveTrustedClientIds(env('good,bad entry'))).toEqual(['good']);
        expect(resolveTrustedClientIds(env('a,b,c,d,e,f'))).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('fails closed when a set value holds no valid entry: every delegated token is refused', () => {
        expect(resolveTrustedClientIds(env('bad entry'))).toEqual([]);
    });
});
