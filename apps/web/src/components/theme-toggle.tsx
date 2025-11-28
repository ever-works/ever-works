'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useTheme } from '@/lib/hooks/use-theme';

interface ThemeToggleProps {
    className?: string;
    variant?: 'fixed' | 'inline';
}

export function ThemeToggle({ className, variant = 'fixed' }: ThemeToggleProps = {}) {
    const { isDark, mounted, toggleTheme } = useTheme();

    const buttonClasses =
        variant === 'fixed'
            ? 'fixed top-4 right-4 z-50 bg-surface dark:bg-surface-dark border border-border dark:border-border-dark'
            : '';

    // Prevent hydration mismatch by not rendering until mounted
    if (!mounted) {
        return (
            <Button
                variant="ghost"
                size="icon"
                className={cn(buttonClasses, className)}
                aria-label="Toggle theme"
            >
                <div className="w-5 h-5" />
            </Button>
        );
    }

    return (
        <Button
            onClick={() => toggleTheme()}
            variant="ghost"
            size="icon"
            className={cn(buttonClasses, className)}
            aria-label="Toggle theme"
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
            {isDark ? (
                <svg
                    className="w-5 h-5 text-text dark:text-text-dark"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"
                    />
                </svg>
            ) : (
                <svg
                    className="w-5 h-5 text-text dark:text-text-dark"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                >
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"
                    />
                </svg>
            )}
        </Button>
    );
}
