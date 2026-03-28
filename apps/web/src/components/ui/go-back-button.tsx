'use client';

import { useRouter } from 'next/navigation';

export function GoBackButton({ label }: { label: string }) {
    const router = useRouter();

    return (
        <button
            onClick={() => router.back()}
            className="inline-flex items-center justify-center px-6 py-2.5 rounded-lg font-medium transition-colors border border-border dark:border-border-dark text-text dark:text-text-dark hover:bg-surface-secondary dark:hover:bg-surface-secondary-dark"
        >
            {label}
        </button>
    );
}
