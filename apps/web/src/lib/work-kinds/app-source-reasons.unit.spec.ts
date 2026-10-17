import { describe, expect, it } from 'vitest';
import { APP_SOURCE_REASON_CODES } from '@ever-works/contracts';
import messages from '../../../messages/en.json';
import {
    APP_SOURCE_REASON_KEYS,
    APP_SOURCE_REASON_NAMESPACE,
    appSourceReasonKey,
    appSourceReasonParams,
    formatRepositorySizeKb,
} from './app-source-reasons';

/** Read a dotted key out of the English catalogue. */
function lookup(key: string): unknown {
    return key.split('.').reduce<unknown>((node, part) => {
        if (node && typeof node === 'object') return (node as Record<string, unknown>)[part];
        return undefined;
    }, messages);
}

/**
 * APW-01 T21 — the reason code ⇒ i18n key map (spec §6.3).
 */
describe('app-source-reasons', () => {
    it('maps every one of the 24 §6.3 codes to a key present in en.json', () => {
        expect(APP_SOURCE_REASON_CODES).toHaveLength(24);
        for (const code of APP_SOURCE_REASON_CODES) {
            const key = appSourceReasonKey(code);
            expect(key).toBe(`${APP_SOURCE_REASON_NAMESPACE}.${APP_SOURCE_REASON_KEYS[code]}`);
            const copy = lookup(key as string);
            expect(typeof copy, `en.json is missing ${key}`).toBe('string');
            expect((copy as string).length).toBeGreaterThan(0);
        }
    });

    it('answers no key for a code outside the closed set', () => {
        expect(appSourceReasonKey('something_new')).toBeNull();
        expect(appSourceReasonKey(undefined)).toBeNull();
        expect(appSourceReasonKey(42)).toBeNull();
    });

    it('always supplies every placeholder, with a neutral dash for unknown values', () => {
        expect(appSourceReasonParams({ owner: 'acme' })).toEqual({
            owner: 'acme',
            size: '—',
            name: '—',
            fullName: '—',
            workName: '—',
            time: '—',
        });
    });

    it('formats GitHub KB sizes for the copy', () => {
        expect(formatRepositorySizeKb(512_000)).toBe('500 MB');
        expect(formatRepositorySizeKb(2 * 1024 * 1024)).toBe('2.0 GB');
        expect(formatRepositorySizeKb(1024)).toBe('1.0 MB');
        expect(formatRepositorySizeKb(null)).toBe('—');
        expect(formatRepositorySizeKb(Number.NaN)).toBe('—');
    });
});
