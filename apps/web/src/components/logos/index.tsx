'use client';

import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { getSiteConfig } from '@/lib/constants';
import { DirectoryConfig } from '@/lib/api';

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
    size = 120,
    priority = false,
    config: configProps,
}: {
    className?: string;
    size?: number;
    priority?: boolean;
    config?: DirectoryConfig | null;
}) {
    const siteConfig = getSiteConfig(configProps);
    const logoHref = siteConfig.website || '/';

    return (
        <Link href={logoHref} className={cn('relative flex items-center', className)}>
            <Image
                src={siteConfig.favicon.light}
                alt={siteConfig.name}
                width={size}
                height={size}
                priority={priority}
                className="block dark:hidden object-contain max-h-8 ml-2.5"
            />
            <Image
                src={siteConfig.favicon.dark}
                alt={siteConfig.name}
                width={size}
                height={size}
                priority={priority}
                className="hidden dark:block object-contain max-h-8 ml-2.5"
            />
        </Link>
    );
}
