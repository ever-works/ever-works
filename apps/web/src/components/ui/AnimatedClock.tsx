export function AnimatedClock({ className }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="12" x2="12" y2="8" />
            <line x1="12" y1="12" x2="16" y2="12">
                <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from="0 12 12"
                    to="360 12 12"
                    dur="8s"
                    repeatCount="indefinite"
                />
            </line>
            <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        </svg>
    );
}
