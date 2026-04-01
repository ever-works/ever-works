'use client';

import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { getSiteConfig } from '@/lib/constants';
import { DirectoryConfig } from '@/lib/api';
import { useTheme } from '@/lib/hooks/use-theme';

interface LogoEverWorkProps {
    className?: string;
    size?: number;
    priority?: boolean;
    config?: DirectoryConfig | null;
}

export function LogoEverWork({
    className,
    size = 120,
    priority = true,
    config: configProps,
}: LogoEverWorkProps) {
    const siteConfig = getSiteConfig(configProps);
    const logoHref = siteConfig.website || '/';

    return (
        <Link href={logoHref} className={cn('relative flex items-center', className)}>
            <Image
                src={siteConfig.logo.light}
                alt={siteConfig.name}
                width={size}
                height={size}
                priority={priority}
                className="block dark:hidden h-auto w-auto max-h-12 object-contain"
            />
            <Image
                src={siteConfig.logo.dark}
                alt={siteConfig.name}
                width={size}
                height={size}
                priority={priority}
                className="hidden dark:block h-auto w-auto max-h-12 object-contain"
            />
        </Link>
    );
}

export function FaviconEverWork({
    className,
    config: configProps,
}: {
    className?: string;
    config?: DirectoryConfig | null;
}) {
    const siteConfig = getSiteConfig(configProps);
    const { isDark, mounted } = useTheme();
    const faviconSrc = mounted && isDark ? siteConfig.favicon.dark : siteConfig.favicon.light;

    return (
        <Link
            href={siteConfig.website || '/'}
            className={cn('relative flex items-center', className)}
        >
            <Image
                key={faviconSrc}
                src={faviconSrc}
                alt={siteConfig.name}
                width={120}
                height={120}
                style={{ animationDuration: '10s' }}
                className="object-contain max-h-8 ml-[8.5px] animate-spin motion-reduce:animate-none"
            />
        </Link>
    );
}
