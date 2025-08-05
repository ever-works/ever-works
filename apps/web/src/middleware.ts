import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';
import { NextRequest } from 'next/server';

const nextIntlMiddleware = createMiddleware(routing);

export default async function middleware(req: NextRequest) {
    const originalPathname = req.nextUrl.pathname;

    const intlResponse = await nextIntlMiddleware(req);

    const segments = originalPathname.split('/').filter(Boolean);
    const maybeLocale = segments[0];
    const hasLocale = routing.locales.includes(maybeLocale as any);
    const pathWithoutLocale = hasLocale ? `/${segments.slice(1).join('/')}` : originalPathname;

    return intlResponse;
}

export const config = {
    // Match all pathnames except for
    // - … if they start with `/api`, `/trpc`, `/_next` or `/_vercel`
    // - … the ones containing a dot (e.g. `favicon.ico`)
    matcher: '/((?!api|trpc|_next|_vercel|.*\\..*).*)',
};
