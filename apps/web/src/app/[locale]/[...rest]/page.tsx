import { notFound } from 'next/navigation';

// Prevent search engines from indexing this 404 catch-all page
export const metadata = {
    robots: 'noindex',
};

// The catch-all delegates to Next.js's `notFound()` so the response is
// a proper 404 (rendered by the sibling `not-found.tsx`) rather than a
// 200 that just LOOKS like a 404 page. A 200 here lies to crawlers,
// CDN caches, and the cache-poisoning / error-page-contract checks —
// all of which key on the status code, not on body content.
export default function CatchAllNotFound(): never {
    notFound();
}
