'use client';

import { useTransition } from 'react';
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

    const handleClick = () => {
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

            toast.success(result.message || labels.stopRequested);
            onCancelled?.();
        });
    };

    return (
        <Button
            variant="danger"
            size="sm"
            loading={isPending}
            onClick={handleClick}
            className={className}
        >
            {isPending ? labels.stopping : labels.stop}
        </Button>
    );
}
