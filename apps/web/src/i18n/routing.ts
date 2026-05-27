import { DEFAULT_LOCALE, LOCALES } from '@/lib/constants';
import { defineRouting } from 'next-intl/routing';

export const routing = defineRouting({
    // A list of all locales that are supported
    locales: LOCALES,

    // Used when no locale matches
    defaultLocale: DEFAULT_LOCALE,

    // app.ever.works is a SaaS app served behind auth, not a multi-locale
    // public website — the locale belongs in user state, not in the URL.
    // With `'never'`, next-intl persists the locale in the `NEXT_LOCALE`
    // cookie and middleware rewrites `/works` → `/<locale>/works`
    // internally without ever surfacing the segment to the browser.
    localePrefix: 'never',
});
