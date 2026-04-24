import { extractPipelineUsageMetrics } from '../metrics.util';
import type { PipelineMetrics } from '@ever-works/plugin';

describe('extractPipelineUsageMetrics', () => {
    it('uses agent-pipeline tokenUsage totals when available', () => {
        const metrics = {
            startTime: Date.now(),
            itemsProcessed: 3,
            steps: {},
            tokenUsage: {
                total: {
                    totalTokens: 1234,
                },
            },
        } as PipelineMetrics & {
            tokenUsage: {
                total: {
                    totalTokens: number;
                };
            };
        };

        expect(extractPipelineUsageMetrics(metrics)).toEqual({
            total_tokens_used: 1234,
        });
    });

    it('falls back to summing standard-pipeline step metrics', () => {
        const metrics: PipelineMetrics = {
            startTime: Date.now(),
            itemsProcessed: 2,
            steps: {
                a: {
                    name: 'A',
                    startTime: Date.now(),
                    success: true,
                    custom: {
                        totalTokens: 100,
                        totalCost: 0.12,
                    },
                },
                b: {
                    name: 'B',
                    startTime: Date.now(),
                    success: true,
                    custom: {
                        totalTokens: 50,
                        totalCost: 0.08,
                    },
                },
            },
        };

        expect(extractPipelineUsageMetrics(metrics)).toEqual({
            total_tokens_used: 150,
            total_cost: 0.2,
        });
    });

    it('prefers explicit top-level token totals over step totals', () => {
        const metrics = {
            startTime: Date.now(),
            itemsProcessed: 1,
            steps: {
                a: {
                    name: 'A',
                    startTime: Date.now(),
                    success: true,
                    custom: {
                        totalTokens: 999,
                        totalCost: 0.05,
                    },
                },
            },
            tokenUsage: {
                total: {
                    totalTokens: 200,
                },
            },
        } as PipelineMetrics & {
            tokenUsage: {
                total: {
                    totalTokens: number;
                };
            };
        };

        expect(extractPipelineUsageMetrics(metrics)).toEqual({
            total_tokens_used: 200,
            total_cost: 0.05,
        });
    });

    it('uses explicit top-level total cost when present', () => {
        const metrics = {
            startTime: Date.now(),
            itemsProcessed: 1,
            steps: {},
            totalCost: 1.2345,
        } as PipelineMetrics & {
            totalCost: number;
        };

        expect(extractPipelineUsageMetrics(metrics)).toEqual({
            total_cost: 1.2345,
        });
    });
});
