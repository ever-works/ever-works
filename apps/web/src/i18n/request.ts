import { Formats, hasLocale } from 'next-intl';
import { routing } from './routing';
import deepmerge from 'deepmerge';

import { getRequestConfig } from 'next-intl/server';

export const formats = {
    dateTime: {
        short: {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
        },
    },
    number: {
        precise: {
            maximumFractionDigits: 5,
        },
    },
    list: {
        enumeration: {
            style: 'long',
            type: 'conjunction',
        },
    },
} satisfies Formats;

// Security: hardcoded allowlist regex for locale values used in dynamic import paths — defense-in-depth
// against path traversal if hasLocale ever fails open (e.g. prototype pollution) or is removed.
const SAFE_LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

export default getRequestConfig(async ({ requestLocale }) => {
    const requested = await requestLocale;
    const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

    // Security: validate locale against strict BCP 47 pattern before using it in a dynamic import path.
    const safeLocale = SAFE_LOCALE_RE.test(locale) ? locale : routing.defaultLocale;
    const userMessages = (await import(`../../messages/${safeLocale}.json`)).default;
    const defaultMessages = (await import(`../../messages/en.json`)).default;
    const messages = deepmerge(defaultMessages, userMessages) as any;

    return {
        locale,
        messages,
    };
});
