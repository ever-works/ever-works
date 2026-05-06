import type { Metadata } from 'next';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { notFound } from 'next/navigation';
import Script from 'next/script';
import { routing } from '@/i18n/routing';
import { Toaster } from 'sonner';

import './globals.css';
import { themeInitScript } from '@/lib/theme-init';
import { TopLoader } from '@/components/ui/top-loader';
import { APP_NAME } from '@/lib/constants';

export const metadata: Metadata = {
    title: {
        template: `%s | ${APP_NAME}`,
        default: `${APP_NAME} — Workshop for AI`,
    },
    description:
        process.env.NEXT_PUBLIC_SITE_DESCRIPTION ||
        process.env.APP_DESCRIPTION ||
        'An agentic runtime that autonomously builds and maintains content-rich web apps and Git repositories',
};

export default async function RootLayout({
    children,
    params,
}: {
    children: React.ReactNode;
    params: Promise<{ locale: string }>;
}) {
    // Ensure that the incoming `locale` is valid
    const { locale } = await params;
    if (!hasLocale(routing.locales, locale)) {
        notFound();
    }

    return (
        <html lang={locale} suppressHydrationWarning>
            <head>
                <Script id="theme-init" strategy="beforeInteractive">
                    {themeInitScript}
                </Script>
            </head>
            <body className="antialiased" suppressHydrationWarning>
                <TopLoader />
                <NextIntlClientProvider>
                    {children}
                    <Toaster
                        position="top-right"
                        theme="system"
                        toastOptions={{
                            className:
                                'sonner-toast !bg-surface dark:!bg-surface-dark !text-text dark:!text-text-dark !border !border-border dark:!border-border-dark',
                            style: {
                                background: undefined,
                                color: undefined,
                                border: undefined,
                            },
                        }}
                    />
                </NextIntlClientProvider>
            </body>
        </html>
    );
}
