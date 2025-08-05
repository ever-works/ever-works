'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AuthLayout } from '@/components/layout/AuthLayout';

export default function RegisterPage() {
    const router = useRouter();
    const [formData, setFormData] = useState({
        name: '',
        email: '',
        password: '',
        confirmPassword: '',
    });

    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');

        // Validation
        if (formData.password !== formData.confirmPassword) {
            setError('Passwords do not match');
            return;
        }

        if (formData.password.length < 8) {
            setError('Password must be at least 8 characters');
            return;
        }

        setLoading(true);

        try {
            // Simulate API call
            await new Promise((resolve) => setTimeout(resolve, 1000));

            // On success, redirect to dashboard
            router.push('/dashboard');
        } catch (err) {
            setError('An error occurred. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <AuthLayout title="Create your account" subtitle="Start building amazing directories today">
            <form onSubmit={handleSubmit} className="space-y-6">
                {error && (
                    <div className="bg-danger/10 border border-danger/20 text-danger px-4 py-3 rounded-lg text-sm">
                        {error}
                    </div>
                )}

                <div>
                    <label htmlFor="name" className="block text-sm font-medium text-text mb-2">
                        Full name
                    </label>
                    <input
                        id="name"
                        type="text"
                        required
                        value={formData.name}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        className="w-full px-4 py-3 bg-surface-secondary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-primary transition-colors"
                        placeholder="John Doe"
                    />
                </div>

                <div>
                    <label htmlFor="email" className="block text-sm font-medium text-text mb-2">
                        Email address
                    </label>
                    <input
                        id="email"
                        type="email"
                        required
                        value={formData.email}
                        onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                        className="w-full px-4 py-3 bg-surface-secondary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-primary transition-colors"
                        placeholder="you@example.com"
                    />
                </div>

                <div>
                    <label htmlFor="password" className="block text-sm font-medium text-text mb-2">
                        Password
                    </label>
                    <input
                        id="password"
                        type="password"
                        required
                        value={formData.password}
                        onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                        className="w-full px-4 py-3 bg-surface-secondary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-primary transition-colors"
                        placeholder="Create a strong password"
                    />
                    <p className="mt-1 text-xs text-text-muted">Must be at least 8 characters</p>
                </div>

                <div>
                    <label
                        htmlFor="confirmPassword"
                        className="block text-sm font-medium text-text mb-2"
                    >
                        Confirm password
                    </label>
                    <input
                        id="confirmPassword"
                        type="password"
                        required
                        value={formData.confirmPassword}
                        onChange={(e) =>
                            setFormData({ ...formData, confirmPassword: e.target.value })
                        }
                        className="w-full px-4 py-3 bg-surface-secondary border border-border rounded-lg text-text placeholder-text-muted focus:outline-none focus:border-primary transition-colors"
                        placeholder="Confirm your password"
                    />
                </div>

                <div className="flex items-start">
                    <input
                        id="terms"
                        type="checkbox"
                        required
                        className="w-4 h-4 mt-0.5 bg-surface-secondary border-border rounded text-primary focus:ring-primary"
                    />

                    <label htmlFor="terms" className="ml-2 text-sm text-text-secondary">
                        I agree to the{' '}
                        <Link href="/terms" className="text-primary hover:text-primary-hover">
                            Terms of Service
                        </Link>{' '}
                        and{' '}
                        <Link href="/privacy" className="text-primary hover:text-primary-hover">
                            Privacy Policy
                        </Link>
                    </label>
                </div>

                <button
                    type="submit"
                    disabled={loading}
                    className="w-full py-3 bg-primary hover:bg-primary-hover text-white rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {loading ? 'Creating account...' : 'Create account'}
                </button>

                <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-border" />
                    </div>
                    <div className="relative flex justify-center text-sm">
                        <span className="bg-background px-2 text-text-muted">Or sign up with</span>
                    </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                    <button
                        type="button"
                        className="flex items-center justify-center gap-2 px-4 py-3 bg-surface-secondary hover:bg-surface-tertiary border border-border rounded-lg text-text transition-colors"
                    >
                        <svg className="w-5 h-5" viewBox="0 0 24 24">
                            <path
                                fill="#4285F4"
                                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                            />
                            <path
                                fill="#34A853"
                                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                            />
                            <path
                                fill="#FBBC05"
                                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                            />
                            <path
                                fill="#EA4335"
                                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                            />
                        </svg>
                        Google
                    </button>
                    <button
                        type="button"
                        className="flex items-center justify-center gap-2 px-4 py-3 bg-surface-secondary hover:bg-surface-tertiary border border-border rounded-lg text-text transition-colors"
                    >
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                        </svg>
                        GitHub
                    </button>
                </div>

                <p className="text-center text-sm text-text-secondary">
                    Already have an account?{' '}
                    <Link
                        href="/login"
                        className="text-primary hover:text-primary-hover font-medium transition-colors"
                    >
                        Sign in
                    </Link>
                </p>
            </form>
        </AuthLayout>
    );
}
