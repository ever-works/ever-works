'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils/cn';

interface CardDecorationProps {
    accentClassName?: string;
    wrapperClassName?: string;
    imageClassName?: string;
}

export function CardDecoration({
    accentClassName,
    wrapperClassName,
    imageClassName,
}: CardDecorationProps) {
    return (
        <>
            <div
                className={cn(
                    'card-top-accent pointer-events-none absolute left-1/2 -translate-x-1/2 top-0 w-1/2 h-px z-20 rounded-full',
                    accentClassName,
                )}
            />

            <div
                className={cn(
                    'pointer-events-none absolute left-0 right-0 top-0 z-20',
                    wrapperClassName,
                )}
            >
                <Image
                    src="/bg-cards.png"
                    alt="Decorative pattern"
                    className={cn(
                        'w-full filter brightness-0 dark:brightness-200 -rotate-180',
                        imageClassName,
                    )}
                    width={200}
                    height={100}
                    unoptimized
                />
            </div>
        </>
    );
}
