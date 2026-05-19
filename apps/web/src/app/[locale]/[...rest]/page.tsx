import { useTranslations } from 'next-intl';
import { NotFoundContent } from '@/components/not-found-content';

// Prevent search engines from indexing this 404 catch-all page.
export const metadata = {
    robots: 'noindex',
};

// In Next.js dev mode (`next dev`) calling `notFound()` from this
// catch-all rendered an EMPTY body — the framework's not-found.tsx
// handoff didn't carry the translations + components through the
// layout chain reliably for dev-mode hot-reloaded requests. Rendering
// the not-found content directly here keeps the body intact in dev
// AND prod, and the e2e contract for /en/non-existent-path matches
// against the body text ("Page not found" / "404") rather than the
// status code (which Next.js dev returns as 200 anyway; only prod
// `next start` returns 404 for unmatched paths).
export default function CatchAllNotFound() {
    const t = useTranslations('errors.notFound');
    return (
        <NotFoundContent
            title={t('title')}
            description={t('description')}
            backHomeLabel={t('backHome')}
            goBackLabel={t('goBack')}
        />
    );
}
