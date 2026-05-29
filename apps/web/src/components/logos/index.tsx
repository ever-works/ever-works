'use client';

import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { getSiteConfig } from '@/lib/constants';
import { WorkConfig } from '@/lib/api';
import { useTheme } from '@/lib/hooks/use-theme';

interface LogoEverWorkProps {
    className?: string;
    /** Intrinsic width hint for Next.js Image (px). Actual render size is controlled by CSS. */
    width?: number;
    /** Intrinsic height hint for Next.js Image (px). Actual render size is controlled by CSS. */
    height?: number;
    priority?: boolean;
    config?: WorkConfig | null;
}

/**
 * Wordmark image only — no `<Link>` wrapper. Use this when the logo
 * needs to live inside another interactive element (e.g. the
 * `<WorkspaceSwitcher>` dropdown trigger) where nesting a `<Link>`
 * inside a `<button>` would be invalid HTML.
 */
export function LogoEverWorkImage({
    className,
    width = 120,
    height = 40,
    priority = true,
    config: configProps,
}: LogoEverWorkProps) {
    const siteConfig = getSiteConfig(configProps);
    return (
        <span className={cn('relative flex items-center', className)}>
            <Image
                src={siteConfig.logo.light}
                alt={siteConfig.name}
                width={width}
                height={height}
                priority={priority}
                className="block dark:hidden h-auto w-auto max-h-12 object-contain"
            />
            <Image
                src={siteConfig.logo.dark}
                alt={siteConfig.name}
                width={width}
                height={height}
                priority={false}
                className="hidden dark:block h-auto w-auto max-h-12 object-contain"
            />
        </span>
    );
}

export function LogoEverWork({
    className,
    width = 120,
    height = 40,
    priority = true,
    config: configProps,
}: LogoEverWorkProps) {
    // Derive only what this wrapper needs; LogoEverWorkImage derives its own.
    const logoHref = getSiteConfig(configProps).website || '/';

    return (
        <Link href={logoHref} className={cn('relative flex items-center', className)}>
            <LogoEverWorkImage
                width={width}
                height={height}
                priority={priority}
                config={configProps}
            />
        </Link>
    );
}

/**
 * Spinning favicon image only — no `<Link>` wrapper. Same rationale as
 * `LogoEverWorkImage`: lets the favicon be embedded inside other
 * interactive elements (or composed alongside other content) without
 * nesting links.
 */
export function FaviconEverWorkImage({
    className,
    config: configProps,
    size = 32,
}: {
    className?: string;
    config?: WorkConfig | null;
    size?: number;
}) {
    const siteConfig = getSiteConfig(configProps);
    const { isDark, mounted } = useTheme();
    const faviconSrc = mounted && isDark ? siteConfig.favicon.dark : siteConfig.favicon.light;

    return (
        <Image
            key={faviconSrc}
            src={faviconSrc}
            alt={siteConfig.name}
            width={size}
            height={size}
            style={{ animationDuration: '10s' }}
            className={cn(
                'object-contain max-h-8 animate-spin motion-reduce:animate-none',
                className,
            )}
        />
    );
}

export function FaviconEverWork({
    className,
    config: configProps,
}: {
    className?: string;
    config?: WorkConfig | null;
}) {
    const siteConfig = getSiteConfig(configProps);

    return (
        <Link
            href={siteConfig.website || '/'}
            className={cn('relative flex items-center', className)}
        >
            <FaviconEverWorkImage config={configProps} className="ml-[10.5px]" />
        </Link>
    );
}
