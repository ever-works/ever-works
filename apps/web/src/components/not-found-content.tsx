import Link from 'next/link';
import { ROUTES } from '@/lib/constants';
import { GoBackButton } from '@/components/ui/go-back-button';

interface NotFoundContentProps {
    title: string;
    description: string;
    backHomeLabel: string;
    goBackLabel: string;
}

export function NotFoundContent({
    title,
    description,
    backHomeLabel,
    goBackLabel,
}: NotFoundContentProps) {
    return (
        <div className="flex min-h-screen items-center justify-center bg-background dark:bg-background-dark px-4">
            <div className="text-center max-w-lg animate-fade-in">
                {/* Decorative 404 */}
                <div className="relative mb-8">
                    <p className="text-[10rem] leading-none font-bold text-border dark:text-border-dark select-none">
                        404
                    </p>
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center">
                            <svg
                                className="w-10 h-10 text-primary"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={1.5}
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
                                />
                            </svg>
                        </div>
                    </div>
                </div>

                <h1 className="text-2xl font-semibold text-text dark:text-text-dark mb-3">
                    {title}
                </h1>
                <p className="text-text-muted dark:text-text-muted-dark mb-8 leading-relaxed">
                    {description}
                </p>
                <div className="flex items-center justify-center gap-3">
                    <Link
                        href={ROUTES.DASHBOARD}
                        className="inline-flex items-center justify-center px-6 py-2.5 rounded-lg font-medium transition-colors bg-primary text-white hover:bg-primary-hover"
                    >
                        {backHomeLabel}
                    </Link>
                    <GoBackButton label={goBackLabel} />
                </div>
            </div>
        </div>
    );
}
