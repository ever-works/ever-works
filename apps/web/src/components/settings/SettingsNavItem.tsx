'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { ChevronRight, ChevronDown } from 'lucide-react';
import Link from 'next/link';

interface SettingsNavItemProps {
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    href?: string;
    isActive?: boolean;
    isExpanded?: boolean;
    hasChildren?: boolean;
    onToggle?: () => void;
    children?: React.ReactNode;
    indicator?: React.ReactNode;
}

export function SettingsNavItem({
    label,
    icon: Icon,
    href,
    isActive = false,
    isExpanded = false,
    hasChildren = false,
    onToggle,
    children,
    indicator,
}: SettingsNavItemProps) {
    const baseClasses = cn(
        'w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left transition-colors',
        isActive
            ? 'bg-surface-secondary dark:bg-surface-secondary-dark text-text dark:text-text-dark font-medium'
            : 'text-text-muted dark:text-text-muted-dark hover:bg-surface dark:hover:bg-surface-dark hover:text-text dark:hover:text-text-dark',
    );

    const content = (
        <>
            <Icon className="w-5 h-5" />
            <span className="flex-1">{label}</span>
            {indicator}
            {hasChildren &&
                (isExpanded ? (
                    <ChevronDown className="w-4 h-4" />
                ) : (
                    <ChevronRight className="w-4 h-4" />
                ))}
        </>
    );

    if (hasChildren) {
        return (
            <div>
                <button onClick={onToggle} className={baseClasses}>
                    {content}
                </button>
                {isExpanded && (
                    <div className="ml-4 pl-4 border-l border-border dark:border-border-dark mt-1 space-y-1">
                        {children}
                    </div>
                )}
            </div>
        );
    }

    if (href) {
        return (
            <Link href={href} className={baseClasses}>
                {content}
            </Link>
        );
    }

    return (
        <button onClick={onToggle} className={baseClasses}>
            {content}
        </button>
    );
}
