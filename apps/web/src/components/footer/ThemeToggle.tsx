'use client';

import { useTheme } from './use-theme';
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
                'flex flex-row items-start bg-surface-secondary dark:bg-surface-secondary-dark py-1 px-2 rounded-[60px] gap-[10px]',
                'border border-border dark:border-border-dark',
                className,
            )}
        >
            <button
                onClick={onClickOne}
                className={cn(
                    'flex flex-row justify-center items-center p-2 w-8 h-8 rounded-[60px] ml-[-2px]',
                    'bg-white shadow-md dark:bg-transparent dark:shadow-none',
                    firstBtnClassName,
                )}
            >
                {childrenArr[0] || <></>}
            </button>

            <button
                onClick={onClickTwo}
                className={cn(
                    'flex flex-row justify-center items-center p-2 w-8 h-8 rounded-[60px] mr-[-2px]',
                    'dark:bg-[#3B4454]',
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
                    'flex flex-row items-start bg-surface-secondary dark:bg-surface-secondary-dark py-1 px-2 rounded-[60px] gap-[10px]',
                    'border border-border dark:border-border-dark',
                    className,
                )}
                aria-hidden="true"
            >
                <div className="flex flex-row justify-center items-center p-2 w-8 h-8 rounded-[60px] ml-[-2px] bg-white shadow-md dark:bg-transparent dark:shadow-none">
                    <Sun className="h-[18px] w-[18px] text-[#382686]" />
                </div>
                <div className="flex flex-row justify-center items-center p-2 w-8 h-8 rounded-[60px] mr-[-2px] dark:bg-[#3B4454]">
                    <Moon className="h-[18px] w-[18px]" />
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
                <Sun className="hidden dark:inline-block h-[18px] w-[18px] dark:text-white" />
                {/* Sun filled for light mode */}
                <Sun className="dark:hidden inline-block h-[18px] w-[18px] text-[#382686]" fill="currentColor" />
            </>
            <>
                {/* Moon filled for dark mode */}
                <Moon className="h-[18px] w-[18px] hidden text-white dark:inline-block" fill="currentColor" />
                {/* Moon outline for light mode */}
                <Moon className="dark:hidden inline-block h-[18px] w-[18px]" />
            </>
        </Toggler>
    );
}

