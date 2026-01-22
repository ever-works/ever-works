import { Injectable, Logger } from '@nestjs/common';
import { IPipelineStep, GenerationContext } from '../interfaces/pipeline.interface';
import { ItemsGeneratorStep } from '../constants/steps';
import { SmartImageRouterService } from '../../screenshot/smart-image-router.service';
import { ScreenshotOneService } from '../../screenshot/screenshot-one.service';
import { DomainType } from '../interfaces/items-generator.interfaces';

const IMAGE_CAPTURE_DELAY_MS = 500;

@Injectable()
export class ImageCaptureService implements IPipelineStep {
    private readonly logger = new Logger(ImageCaptureService.name);
    public readonly name = ItemsGeneratorStep.IMAGE_CAPTURE;

    constructor(
        private readonly smartImageRouterService: SmartImageRouterService,
        private readonly screenshotService: ScreenshotOneService,
    ) {}

    async run(context: GenerationContext): Promise<GenerationContext> {
        const { directory, dto, finalItems, domainAnalysis } = context;

        if (!dto.capture_screenshots) {
            this.logger.debug(`[${directory.slug}] Image capture disabled, skipping`);
            return context;
        }

        if (!this.screenshotService.isAvailable(directory.user)) {
            this.logger.warn(
                `[${directory.slug}] Screenshot service not configured, skipping image capture`,
            );
            return context;
        }

        if (!domainAnalysis) {
            this.logger.warn(
                `[${directory.slug}] No domain analysis available, skipping image capture`,
            );
            return context;
        }

        const itemsNeedingImages = finalItems.filter(
            (item) => item.source_url && (!item.images || item.images.length === 0),
        );

        if (itemsNeedingImages.length === 0) {
            this.logger.debug(`[${directory.slug}] No items need images`);
            return context;
        }

        const domainType = domainAnalysis.domain_type as DomainType;
        this.logger.log(
            `[${directory.slug}] Capturing images for ${itemsNeedingImages.length} items (domain: ${domainType})`,
        );

        for (const item of itemsNeedingImages) {
            try {
                const result = await this.smartImageRouterService.getSmartImage({
                    url: item.source_url!,
                    domainType,
                    itemName: item.name,
                    user: directory.user,
                });

                if (result.primaryImage) {
                    item.images = [result.primaryImage, ...(item.images || [])];
                    this.logger.debug(
                        `[${directory.slug}] Captured ${result.source} image for ${item.name}`,
                    );
                }
            } catch (error) {
                this.logger.warn(
                    `[${directory.slug}] Failed to capture image for ${item.name}: ${error instanceof Error ? error.message : 'Unknown error'}`,
                );
            }

            await this.delay(IMAGE_CAPTURE_DELAY_MS);
        }

        this.logger.log(
            `[${directory.slug}] Image capture complete for ${itemsNeedingImages.length} items`,
        );

        return context;
    }

    private delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
