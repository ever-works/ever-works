import en from '../../../../messages/en.json';
import type { PaletteTranslator } from '../registry/types';

function lookup(key: string): unknown {
    return key.split('.').reduce<unknown>((node, segment) => {
        if (node && typeof node === 'object') return (node as Record<string, unknown>)[segment];
        return undefined;
    }, en);
}

function format(message: string, values?: Record<string, string | number | Date>): string {
    return message
        .replace(
            /\{(\w+), plural, one \{# ([^}]*)\} other \{# ([^}]*)\}\}/g,
            (_match, name, one, other) => {
                const count = Number(values?.[name] ?? 0);
                return `${count} ${count === 1 ? one : other}`;
            },
        )
        .replace(/\{(\w+)\}/g, (_match, name) => String(values?.[name] ?? ''));
}

/** Keys the translator was asked for — lets a spec assert which copy rendered. */
export interface RecordingTranslator extends PaletteTranslator {
    requested: Set<string>;
}

/**
 * A translator backed by the real `messages/en.json`. A key that does not
 * resolve to a string throws, so a registry typo fails the spec instead of
 * rendering a raw key.
 */
export function createEnTranslator(): RecordingTranslator {
    const requested = new Set<string>();
    const translate = ((key: string, values?: Record<string, string | number | Date>) => {
        requested.add(key);
        const message = lookup(key);
        if (typeof message !== 'string') {
            throw new Error(`Missing en.json message: ${key}`);
        }
        return format(message, values);
    }) as RecordingTranslator;
    translate.has = (key: string) => typeof lookup(key) === 'string';
    translate.requested = requested;
    return translate;
}
