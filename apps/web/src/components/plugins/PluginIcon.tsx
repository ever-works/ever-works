'use client';

import { useState, useEffect } from 'react';
import { PluginsApiIcon } from '@/lib/api/plugins';
import { cn } from '@/lib/utils/cn';
import { Plug } from 'lucide-react';
import * as LucideIcons from 'lucide-react';

/**
 * Observes the `dark` class on `<html>` so the component re-renders
 * in real time when the user toggles the theme.
 */
function useIsDark(): boolean {
    const [isDark, setIsDark] = useState(false);

    useEffect(() => {
        const root = document.documentElement;
        setIsDark(root.classList.contains('dark'));

        const observer = new MutationObserver(() => {
            setIsDark(root.classList.contains('dark'));
        });
        observer.observe(root, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    return isDark;
}

interface PluginIconProps {
    icon?: PluginsApiIcon;
    name: string;
    size?: number;
    className?: string;
}

export function PluginIcon({ icon, name, size = 32, className }: PluginIconProps) {
    const isDark = useIsDark();
    const containerStyle = { width: size, height: size };

    // Use dark variant when available and in dark mode
    const iconValue = icon && isDark && icon.darkValue ? icon.darkValue : icon?.value;
    const containerClass = cn(
        'flex items-center justify-center rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark',
        className,
    );

    if (!icon) {
        return (
            <div className={containerClass} style={containerStyle}>
                <Plug className="w-1/2 h-1/2 text-text-muted dark:text-text-muted-dark" />
            </div>
        );
    }

    // Handle different icon types based on type/value pattern
    switch (icon.type) {
        case 'svg':
            return (
                <div
                    className={cn(containerClass, 'p-1.5 [&>svg]:w-full [&>svg]:h-full')}
                    style={{
                        ...containerStyle,
                        backgroundColor: icon.backgroundColor,
                        color: icon.color || (icon.backgroundColor ? '#ffffff' : undefined),
                    }}
                    dangerouslySetInnerHTML={{ __html: iconValue! }}
                />
            );

        case 'url':
            return (
                <div
                    className={cn(containerClass, 'overflow-hidden')}
                    style={{ ...containerStyle, backgroundColor: icon.backgroundColor }}
                >
                    <img src={iconValue!} alt={name} className="w-full h-full object-contain" />
                </div>
            );

        case 'base64':
            const dataUrl = iconValue!.startsWith('data:')
                ? iconValue!
                : `data:image/png;base64,${iconValue!}`;
            return (
                <div
                    className={cn(containerClass, 'overflow-hidden')}
                    style={{ ...containerStyle, backgroundColor: icon.backgroundColor }}
                >
                    <img src={dataUrl} alt={name} className="w-full h-full object-contain" />
                </div>
            );

        case 'lucide':
            // Get the Lucide icon component by name
            const iconName = iconValue!.charAt(0).toUpperCase() + iconValue!.slice(1);
            const LucideIcon = (LucideIcons as unknown as Record<string, React.ComponentType<any>>)[
                iconName
            ];
            if (LucideIcon) {
                return (
                    <div
                        className={containerClass}
                        style={{
                            ...containerStyle,
                            backgroundColor: icon.backgroundColor,
                            color: icon.color || (icon.backgroundColor ? '#ffffff' : undefined),
                        }}
                    >
                        <LucideIcon className="w-1/2 h-1/2" />
                    </div>
                );
            }
            // Fallback if icon not found
            return (
                <div className={containerClass} style={containerStyle}>
                    <Plug className="w-1/2 h-1/2 text-text-muted dark:text-text-muted-dark" />
                </div>
            );

        case 'emoji':
            return (
                <div
                    className={containerClass}
                    style={{ ...containerStyle, backgroundColor: icon.backgroundColor }}
                >
                    <span style={{ fontSize: size * 0.5 }}>{iconValue}</span>
                </div>
            );

        default:
            return (
                <div className={containerClass} style={containerStyle}>
                    <Plug className="w-1/2 h-1/2 text-text-muted dark:text-text-muted-dark" />
                </div>
            );
    }
}
