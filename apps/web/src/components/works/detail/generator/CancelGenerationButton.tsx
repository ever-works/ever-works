'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cancelGeneration } from '@/app/actions/dashboard/generator';

type CancelGenerationButtonLabels = {
    stop: string;
    stopping: string;
    stopRequested: string;
    stopFailed: string;
};

interface CancelGenerationButtonProps {
    workId: string;
    labels: CancelGenerationButtonLabels;
    onCancelled?: () => void;
    onAlreadyFinished?: () => void;
    className?: string;
}

export function CancelGenerationButton({
    workId,
    labels,
    onCancelled,
    onAlreadyFinished,
    className,
}: CancelGenerationButtonProps) {
    const [isPending, startTransition] = useTransition();
    const [stopRequested, setStopRequested] = useState(false);
    const resetTimerRef = useRef<number | null>(null);

    useEffect(() => {
        return () => {
            if (resetTimerRef.current !== null) {
                window.clearTimeout(resetTimerRef.current);
            }
        };
    }, []);

    const handleClick = () => {
        if (stopRequested) {
            return;
        }

        startTransition(async () => {
            const result = await cancelGeneration(workId);

            if (!result.success) {
                toast.error(result.error || labels.stopFailed);

                return;
            }

            if (result.data.mode === 'already_finished') {
                onAlreadyFinished?.();
                return;
            }

            setStopRequested(true);
            if (resetTimerRef.current !== null) {
                window.clearTimeout(resetTimerRef.current);
            }
            resetTimerRef.current = window.setTimeout(() => {
                setStopRequested(false);
                resetTimerRef.current = null;
            }, 10000);
            toast.success(result.message || labels.stopRequested);
            onCancelled?.();
        });
    };

    return (
        <Button
            variant="danger"
            size="sm"
            loading={isPending || stopRequested}
            onClick={handleClick}
            className={className}
            disabled={isPending || stopRequested}
        >
            {isPending || stopRequested ? labels.stopping : labels.stop}
        </Button>
    );
}
