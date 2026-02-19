import { createEmptyPipelineOutputs } from '@ever-works/plugin';
import type { PipelineOutputs, PipelineResult } from '@ever-works/plugin';

export function makePipelineOutputs(overrides?: Partial<PipelineOutputs>): PipelineOutputs {
    return {
        ...createEmptyPipelineOutputs(),
        ...overrides,
    };
}

export function makePipelineResult(
    overrides?: Partial<PipelineResult>,
    outputOverrides?: Partial<PipelineOutputs>,
): PipelineResult {
    return {
        success: true,
        outputs: makePipelineOutputs(outputOverrides),
        duration: 0,
        stepsCompleted: 0,
        totalSteps: 0,
        ...overrides,
    };
}
