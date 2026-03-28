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
    plain?: boolean;
}

export function PluginIcon({ icon, name, size = 32, className, plain = false }: PluginIconProps) {
    const isDark = useIsDark();
    const containerStyle = { width: size, height: size };

    // Use dark variant when available and in dark mode
    const iconValue = icon && isDark && icon.darkValue ? icon.darkValue : icon?.value;
    const containerClass = cn(
        'flex items-center justify-center rounded-lg bg-surface-secondary dark:bg-surface-secondary-dark',
        className,
    );

    if (!icon) {
        if (plain)
            return (
                <Plug
                    style={{ width: size, height: size }}
                    className="text-text-muted dark:text-text-muted-dark"
                />
            );
        return (
            <div className={containerClass} style={containerStyle}>
                <Plug className="w-1/2 h-1/2 text-text-muted dark:text-text-muted-dark" />
            </div>
        );
    }

    // Handle different icon types based on type/value pattern
    switch (icon.type) {
        case 'svg':
            if (plain)
                return (
                    <div
                        style={{ ...containerStyle, color: icon.color || undefined }}
                        className={cn('[&>svg]:w-full [&>svg]:h-full', className)}
                        dangerouslySetInnerHTML={{ __html: iconValue! }}
                    />
                );
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
            if (plain)
                return (
                    <img
                        src={iconValue!}
                        alt={name}
                        style={containerStyle}
                        className={cn('object-contain', className)}
                    />
                );
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
            if (plain)
                return (
                    <img
                        src={dataUrl}
                        alt={name}
                        style={containerStyle}
                        className={cn('object-contain', className)}
                    />
                );
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
                if (plain) return <LucideIcon style={containerStyle} className={cn(className)} />;
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
            if (plain)
                return (
                    <Plug
                        style={containerStyle}
                        className={cn('text-text-muted dark:text-text-muted-dark', className)}
                    />
                );
            return (
                <div className={containerClass} style={containerStyle}>
                    <Plug className="w-1/2 h-1/2 text-text-muted dark:text-text-muted-dark" />
                </div>
            );

        case 'emoji':
            return (
                <div
                    className={plain ? className : containerClass}
                    style={
                        plain
                            ? undefined
                            : { ...containerStyle, backgroundColor: icon.backgroundColor }
                    }
                >
                    <span style={{ fontSize: plain ? size : size * 0.5 }}>{iconValue}</span>
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
