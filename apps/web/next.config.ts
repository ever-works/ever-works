import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

/**
 * @type any
 */
let BUILD_OUTPUT = process.env.NEXT_BUILD_OUTPUT;
BUILD_OUTPUT = ['standalone', 'export'].includes(BUILD_OUTPUT as any) ? BUILD_OUTPUT : undefined;

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
    output: BUILD_OUTPUT as NextConfig['output'],
    experimental: {
        // Webpack mode is used for production builds because Turbopack is
        // currently unstable for this app in CI/local sandboxed environments.
        webpackBuildWorker: false,
    },
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'github.com',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'lh3.googleusercontent.com',
                port: '',
                pathname: '/**',
            },
            {
                protocol: 'https',
                hostname: 'avatars.githubusercontent.com',
                port: '',
                pathname: '/**',
            },
        ],
    },
};

export default withNextIntl(nextConfig);
