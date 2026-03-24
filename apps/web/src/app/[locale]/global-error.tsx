'use client';

import { useEffect } from 'react';
import { themeInitScript } from '@/lib/theme-init';

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        console.error('Global error:', error);
    }, [error]);

    return (
        <html suppressHydrationWarning>
            <head>
                <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
            </head>
            <body className="bg-[#ffffff] text-[#0f172a] dark:bg-[#0f1419] dark:text-[#e2e8f0] font-sans antialiased">
                <div className="flex min-h-screen items-center justify-center px-4">
                    <div className="text-center max-w-lg">
                        <div className="relative mb-8">
                            <p className="text-[10rem] leading-none font-bold text-[#e2e8f0] dark:text-[#1b2434] select-none">
                                500
                            </p>
                            <div className="absolute inset-0 flex items-center justify-center">
                                <div className="w-20 h-20 rounded-2xl bg-[#ef4444]/10 flex items-center justify-center">
                                    <svg
                                        className="w-10 h-10 text-[#ef4444]"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        stroke="currentColor"
                                        strokeWidth={1.5}
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
                                        />
                                    </svg>
                                </div>
                            </div>
                        </div>

                        <h1 className="text-2xl font-semibold mb-3">Something went wrong</h1>
                        <p className="text-[#94a3b8] dark:text-[#64748b] mb-8 leading-relaxed">
                            An unexpected error occurred. Please try again or contact support if the
                            problem persists.
                        </p>
                        {error.digest && (
                            <p className="text-xs text-[#94a3b8] dark:text-[#64748b] mb-6 font-mono bg-[#f1f5f9] dark:bg-[#1e293b] px-3 py-1.5 rounded-md inline-block">
                                Error ID: {error.digest}
                            </p>
                        )}
                        <button
                            onClick={() => reset()}
                            className="inline-flex items-center justify-center gap-2 px-6 py-2.5 rounded-lg font-medium transition-colors bg-[#6366f1] text-white hover:bg-[#4f46e5]"
                        >
                            <svg
                                className="w-4 h-4"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182"
                                />
                            </svg>
                            Try again
                        </button>
                    </div>
                </div>
            </body>
        </html>
    );
}
