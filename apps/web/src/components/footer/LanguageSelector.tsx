'use client';

import { useLocale } from 'next-intl';
import { useRouter, usePathname } from '@/i18n/navigation';
import { LOCALES } from '@/lib/constants';
import {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

type Locale = (typeof LOCALES)[number];

const LOCALE_NAMES: Record<Locale, string> = {
    en: 'En',
    ar: 'Ar',
    bg: 'Bg',
    de: 'De',
    es: 'Es',
    fr: 'Fr',
    he: 'He',
    hi: 'Hi',
    id: 'Id',
    it: 'It',
    ja: 'Ja',
    ko: 'Ko',
    nl: 'Nl',
    pl: 'Pl',
    pt: 'Pt',
    ru: 'Ru',
    th: 'Th',
    tr: 'Tr',
    uk: 'Uk',
    vi: 'Vi',
    zh: 'Zh',
} as const;

const LOCALE_FLAGS: Record<Locale, string> = {
    en: '🇬🇧',
    ar: '🇸🇦',
    bg: '🇧🇬',
    de: '🇩🇪',
    es: '🇪🇸',
    fr: '🇫🇷',
    he: '🇮🇱',
    hi: '🇮🇳',
    id: '🇮🇩',
    it: '🇮🇹',
    ja: '🇯🇵',
    ko: '🇰🇷',
    nl: '🇳🇱',
    pl: '🇵🇱',
    pt: '🇵🇹',
    ru: '🇷🇺',
    th: '🇹🇭',
    tr: '🇹🇷',
    uk: '🇺🇦',
    vi: '🇻🇳',
    zh: '🇨🇳',
} as const;

interface LanguageSelectorProps {
    className?: string;
}

export function LanguageSelector({ className }: LanguageSelectorProps) {
    const locale = useLocale() as Locale;
    const router = useRouter();
    const pathname = usePathname();

    const handleLocaleChange = (newLocale: Locale) => {
        router.replace(pathname, { locale: newLocale });
    };

    const currentLocaleName = LOCALE_NAMES[locale] || LOCALE_NAMES.en;
    const currentLocaleFlag = LOCALE_FLAGS[locale] || LOCALE_FLAGS.en;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className={cn(
                        'inline-flex items-center justify-center',
                        'h-9 min-w-[100px] px-3 text-xs font-normal',
                        'rounded-md transition-all duration-200',
                        'bg-surface-secondary dark:bg-surface-secondary-dark',
                        'border border-border dark:border-border-dark',
                        'text-text dark:text-text-dark',
                        'hover:bg-surface-tertiary dark:hover:bg-surface-tertiary-dark',
                        'hover:border-border-secondary dark:hover:border-border-secondary-dark',
                        'focus:outline-none focus:ring-2 focus:ring-primary/20',
                        'active:scale-[0.98] ',
                        'cursor-pointer',
                        className,
                    )}
                    aria-label="Select language"
                >
                    <span className="mr-2 text-base leading-none" aria-hidden="true">
                        {currentLocaleFlag}
                    </span>
                    <span className="text-xs leading-tight whitespace-nowrap">
                        {currentLocaleName}
                    </span>
                    <ChevronDown
                        className="ml-2 w-3.5 h-3.5 opacity-60 shrink-0"
                        aria-hidden="true"
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="min-w-[160px]">
                {LOCALES.map((loc) => {
                    const isActive = locale === loc;
                    return (
                        <DropdownMenuItem
                            key={loc}
                            onClick={() => handleLocaleChange(loc)}
                            className={cn(
                                'flex items-center gap-2',
                                isActive &&
                                    'bg-surface-tertiary cursor-pointer dark:bg-surface-tertiary-dark font-medium',
                                !isActive && 'cursor-pointer',
                            )}
                        >
                            <span aria-hidden="true">{LOCALE_FLAGS[loc]}</span>
                            <span>{LOCALE_NAMES[loc]}</span>
                            {isActive && (
                                <span
                                    className="ml-auto text-xs text-primary dark:text-primary-dark"
                                    aria-label="Current language"
                                >
                                    ✓
                                </span>
                            )}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
