import Image from 'next/image';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils/cn';

interface LogoEverWorkProps {
    className?: string;
    size?: number;
    priority?: boolean;
}

export function LogoEverWork({ className, size = 120, priority = true }: LogoEverWorkProps = {}) {
    return (
        <Link href="/" className={cn('relative flex items-center', className)}>
            <Image
                src="/logo-light.png"
                alt="Ever Works"
                width={size}
                height={size}
                priority={priority}
                className="block dark:hidden h-auto w-auto max-h-12 object-contain"
            />
            <Image
                src="/logo-ever-work.png"
                alt="Ever Works"
                width={size}
                height={size}
                priority={priority}
                className="hidden dark:block h-auto w-auto max-h-12 object-contain"
            />
        </Link>
    );
}
