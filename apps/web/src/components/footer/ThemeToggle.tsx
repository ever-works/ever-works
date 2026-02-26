'use client';

import { useTheme } from '@/lib/hooks/use-theme';
import { cn } from '@/lib/utils/cn';
import React, { PropsWithChildren } from 'react';
import { Moon, Sun } from 'lucide-react';

interface IClassName {
    className?: string;
}

type TogglerProps = {
    className?: string;
    onClickOne?: () => void;
    onClickTwo?: () => void;
    themeTogger?: boolean;
    firstBtnClassName?: string;
    secondBtnClassName?: string;
} & PropsWithChildren;

export function Toggler({
    children,
    className,
    onClickOne,
    onClickTwo,
    firstBtnClassName,
    secondBtnClassName,
}: TogglerProps) {
    const childrenArr = React.Children.toArray(children);

    return (
        <div
            className={cn(
                'flex flex-row items-center bg-surface-secondary dark:bg-surface-secondary-dark py-0.5 px-1.5 rounded-full gap-2',
                'border border-border dark:border-border-dark',
                className,
            )}
        >
            <button
                onClick={onClickOne}
                className={cn(
                    'flex flex-row justify-center items-center p-1 w-6 h-6 rounded-full ml-[-2px]',
                    'bg-white shadow-sm dark:bg-transparent dark:shadow-none',
                    firstBtnClassName,
                )}
            >
                {childrenArr[0] || <></>}
            </button>

            <button
                onClick={onClickTwo}
                className={cn(
                    'flex flex-row justify-center items-center p-1 w-6 h-6 rounded-full mr-[-2px]',
                    'dark:bg-toggle-dark',
                    secondBtnClassName,
                )}
            >
                {childrenArr[1] || <></>}
            </button>
        </div>
    );
}

export function ThemeToggle({ className }: IClassName) {
    const { toggleTheme, mounted } = useTheme();

    // Prevent hydration mismatch
        if (!mounted) {
        return (
            <div
                className={cn(
                    'flex flex-row items-center bg-surface-secondary dark:bg-surface-secondary-dark py-0.5 px-1.5 rounded-full gap-2',
                    'border border-border dark:border-border-dark',
                    className,
                )}
                aria-hidden="true"
            >
                <div className="flex flex-row justify-center items-center p-1 w-6 h-6 rounded-full ml-[-2px] bg-white shadow-sm dark:bg-transparent dark:shadow-none">
                    <Sun className="h-4 w-4 text-brand-indigo" />
                </div>
                <div className="flex flex-row justify-center items-center p-1 w-6 h-6 rounded-full mr-[-2px] dark:bg-toggle-dark">
                    <Moon className="h-4 w-4" />
                </div>
            </div>
        );
    }

    return (
        <Toggler
            className={className}
            onClickOne={() => toggleTheme('light')}
            onClickTwo={() => toggleTheme('dark')}
        >
            <>
                {/* Sun outline for dark mode */}
                <Sun className="hidden dark:inline-block h-4 w-4 dark:text-white cursor-pointer" />
                {/* Sun filled for light mode */}
                <Sun
                    className="dark:hidden inline-block h-4 w-4 text-brand-indigo cursor-pointer"
                    fill="currentColor"
                />
            </>
            <>
                {/* Moon filled for dark mode */}
                <Moon
                    className="h-4 w-4 hidden text-white dark:inline-block cursor-pointer"
                    fill="currentColor"
                />
                {/* Moon outline for light mode */}
                <Moon className="dark:hidden inline-block h-4 w-4 cursor-pointer" />
            </>
        </Toggler>
    );
}
