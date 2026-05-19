import type { MetadataRoute } from 'next';
import { APP_NAME } from '@/lib/constants';

/**
 * PWA Web App Manifest, served by Next.js at `/manifest.webmanifest`.
 *
 * Kept intentionally minimal: name + short_name + start_url + display
 * + theme/background + a single icon are the canonical PWA fields the
 * Web App Manifest spec (W3C) requires for installability. The
 * `pwa-manifest-shape` e2e contract pins these.
 */
export default function manifest(): MetadataRoute.Manifest {
    return {
        name: APP_NAME,
        short_name: APP_NAME,
        description:
            'Ever Works — agentic runtime that autonomously builds and maintains content-rich web apps and Git repositories.',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        icons: [
            {
                src: '/logo-light.png',
                sizes: 'any',
                type: 'image/png',
            },
        ],
    };
}
