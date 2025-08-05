import Link from 'next/link';

interface AuthLayoutProps {
    children: React.ReactNode;
    title: string;
    subtitle: string;
}

export function AuthLayout({ children, title, subtitle }: AuthLayoutProps) {
    return (
        <div className="min-h-screen bg-background flex">
            {/* Left side - Form */}
            <div className="flex-1 flex items-center justify-center px-8 py-12">
                <div className="w-full max-w-md">
                    <Link
                        href="/"
                        className="inline-flex items-center gap-2 text-text-secondary hover:text-text mb-8 transition-colors"
                    >
                        <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                        >
                            <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M10 19l-7-7m0 0l7-7m-7 7h18"
                            />
                        </svg>
                        Back to home
                    </Link>

                    <div className="mb-8">
                        <h1 className="text-3xl font-bold text-text mb-2">{title}</h1>
                        <p className="text-text-secondary">{subtitle}</p>
                    </div>

                    {children}
                </div>
            </div>

            {/* Right side - Feature showcase */}
            <div className="hidden lg:flex flex-1 bg-surface items-center justify-center px-8 relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent" />

                <div className="relative z-10 max-w-lg -mt-24">
                    <div className="mb-8">
                        <div className="w-16 h-16 bg-primary/20 rounded-lg flex items-center justify-center mb-6">
                            <svg
                                className="w-8 h-8 text-primary"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M13 10V3L4 14h7v7l9-11h-7z"
                                />
                            </svg>
                        </div>
                        <h2 className="text-2xl font-bold text-text mb-4">
                            Build Directories with AI
                        </h2>
                        <p className="text-text-secondary mb-8">
                            Create beautiful, searchable directories in minutes using natural
                            language. No coding required.
                        </p>
                    </div>

                    <div className="space-y-4">
                        <div className="flex items-start gap-3">
                            <div className="w-8 h-8 bg-success/20 rounded-lg flex items-center justify-center flex-shrink-0">
                                <svg
                                    className="w-5 h-5 text-success"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M5 13l4 4L19 7"
                                    />
                                </svg>
                            </div>
                            <div>
                                <h3 className="font-medium text-text mb-1">AI-Powered Creation</h3>
                                <p className="text-sm text-text-secondary">
                                    Describe what you want and let AI do the work
                                </p>
                            </div>
                        </div>

                        <div className="flex items-start gap-3">
                            <div className="w-8 h-8 bg-success/20 rounded-lg flex items-center justify-center flex-shrink-0">
                                <svg
                                    className="w-5 h-5 text-success"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M5 13l4 4L19 7"
                                    />
                                </svg>
                            </div>
                            <div>
                                <h3 className="font-medium text-text mb-1">
                                    Professional Templates
                                </h3>
                                <p className="text-sm text-text-secondary">
                                    Start with beautiful, customizable designs
                                </p>
                            </div>
                        </div>

                        <div className="flex items-start gap-3">
                            <div className="w-8 h-8 bg-success/20 rounded-lg flex items-center justify-center flex-shrink-0">
                                <svg
                                    className="w-5 h-5 text-success"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                >
                                    <path
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeWidth={2}
                                        d="M5 13l4 4L19 7"
                                    />
                                </svg>
                            </div>
                            <div>
                                <h3 className="font-medium text-text mb-1">Easy Management</h3>
                                <p className="text-sm text-text-secondary">
                                    Update and organize your content effortlessly
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
