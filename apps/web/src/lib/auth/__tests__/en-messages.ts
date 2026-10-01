import { createElement, Fragment, type ReactNode } from 'react';
import en from '../../../../messages/en.json';

/**
 * Test helper for the APW-12 (Ever ID) component specs: a `useTranslations`
 * stand-in backed by the real `messages/en.json`.
 *
 * Resolving real copy (rather than echoing the key back) makes an assertion on a
 * sentence an assertion that the key exists, that its value is the spec §6 copy,
 * and that the component interpolates its placeholders. A missing key throws, so
 * a typo fails the spec instead of rendering its own name.
 */

function lookup(path: string): string {
    const value = path.split('.').reduce<unknown>((node, segment) => {
        if (node && typeof node === 'object') return (node as Record<string, unknown>)[segment];
        return undefined;
    }, en);
    if (typeof value !== 'string') {
        throw new Error(`Missing en.json message: ${path}`);
    }
    return value;
}

function interpolate(message: string, values?: Record<string, unknown>): string {
    if (!values) return message;
    return message.replace(/\{(\w+)\}/g, (match, name: string) =>
        name in values ? String(values[name]) : match,
    );
}

/** The English message at `path`, with `{placeholder}` substitution. */
export function enMessage(path: string, values?: Record<string, unknown>): string {
    return interpolate(lookup(path), values);
}

type RichHandlers = Record<string, (chunks: ReactNode) => ReactNode>;

/** `useTranslations(namespace)` over `en.json`, with `t.rich` and `t.has`. */
export function enUseTranslations(namespace?: string) {
    const path = (key: string) => (namespace ? `${namespace}.${key}` : key);

    const translate = (key: string, values?: Record<string, unknown>) =>
        enMessage(path(key), values);

    translate.rich = (key: string, handlers: RichHandlers = {}): ReactNode => {
        const message = lookup(path(key));
        const parts: ReactNode[] = [];
        let cursor = 0;
        for (const match of message.matchAll(/<(\w+)>(.*?)<\/\1>/g)) {
            const [whole, tag, chunk] = match;
            const index = match.index ?? 0;
            if (index > cursor) parts.push(message.slice(cursor, index));
            const handler = handlers[tag];
            parts.push(handler ? handler(chunk) : chunk);
            cursor = index + whole.length;
        }
        if (cursor < message.length) parts.push(message.slice(cursor));
        return createElement(Fragment, null, ...parts);
    };

    translate.has = (key: string) => {
        try {
            lookup(path(key));
            return true;
        } catch {
            return false;
        }
    };

    return translate;
}
