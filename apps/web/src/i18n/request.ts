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

export default getRequestConfig(async ({ requestLocale }) => {
    const requested = await requestLocale;
    const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

    const userMessages = (await import(`../../messages/${locale}.json`)).default;
    const defaultMessages = (await import(`../../messages/en.json`)).default;
    const messages = deepmerge(defaultMessages, userMessages) as any;

    return {
        locale,
        messages,
    };
});
