import { Logger } from '@nestjs/common';
import { GenerationContext, IPipelineStep } from '../../interfaces/pipeline.interface';

export class ParallelStep implements IPipelineStep {
    private readonly logger = new Logger(ParallelStep.name);
    public readonly name: string;

    constructor(private readonly steps: IPipelineStep[]) {
        this.name = `Parallel(${steps.map((s) => s.name).join(', ')})`;
    }

    async run(context: GenerationContext): Promise<GenerationContext> {
        this.logger.log(`Starting parallel execution of ${this.steps.length} steps`);

        // Clone context for each step to avoid race conditions on mutable properties
        // This is a shallow clone, which is usually sufficient if steps modify top-level properties
        // If steps modify deep nested objects, a deep clone might be needed, but that's expensive
        const promises = this.steps.map((step) => {
            // Create a shallow copy of the context
            const stepContext = { ...context };
            return step.run(stepContext);
        });

        const results = await Promise.all(promises);

        this.logger.log(`Parallel execution completed. Merging results.`);

        // Merge results back into the original context
        // We iterate over the results and apply changes to the main context
        // Strategy:
        // 1. We assume steps modify specific disjoint parts of the context (e.g., one sets initialAiItems, another sets searchQueries)
        // 2. We simply overlay the changed properties from each result onto the main context

        let mergedContext = { ...context };

        for (const result of results) {
            // Identify keys that have changed or differ from the original context
            for (const key in result) {
                if (Object.prototype.hasOwnProperty.call(result, key)) {
                    const originalValue = context[key];
                    const newValue = result[key];

                    // If the value is different (reference check), update it
                    if (newValue !== originalValue) {
                        mergedContext[key] = newValue;
                    }
                }
            }
        }

        return mergedContext;
    }
}
