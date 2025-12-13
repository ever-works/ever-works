import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { notFound } from 'next/navigation';
import { routing } from '@/i18n/routing';
import { Toaster } from 'sonner';

import './globals.css';
import { themeInitScript } from '@/lib/theme-init';
import { TopLoader } from '@/components/ui/top-loader';

const geistSans = Geist({
    variable: '--font-geist-sans',
    subsets: ['latin'],
});

const geistMono = Geist_Mono({
    variable: '--font-geist-mono',
    subsets: ['latin'],
});

export const metadata: Metadata = {
    title: `${process.env.NEXT_PUBLIC_APP_NAME || process.env.APP_NAME || 'Ever Works'} - Directory Builder`,
    description:
        process.env.NEXT_PUBLIC_SITE_DESCRIPTION ||
        process.env.APP_DESCRIPTION ||
        'A SaaS platform for building and managing directories',
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
                <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
            </head>
            <body
                className={`${geistSans.variable} ${geistMono.variable} antialiased`}
                suppressHydrationWarning
            >
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
