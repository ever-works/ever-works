import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';
import { SITE_CONFIG } from '@/lib/constants';

interface LogoEverWorkProps {
    className?: string;
    size?: number;
    priority?: boolean;
}

export function LogoEverWork({ className, size = 120, priority = true }: LogoEverWorkProps) {
    return (
        <Link href="/" className={cn('relative flex items-center', className)}>
            <Image
                src={SITE_CONFIG.logo.light}
                alt={SITE_CONFIG.name}
                width={size}
                height={size}
                priority={priority}
                className="block dark:hidden h-auto w-auto max-h-12 object-contain"
            />
            <Image
                src={SITE_CONFIG.logo.dark}
                alt={SITE_CONFIG.name}
                width={size}
                height={size}
                priority={priority}
                className="hidden dark:block h-auto w-auto max-h-12 object-contain"
            />
        </Link>
    );
}
