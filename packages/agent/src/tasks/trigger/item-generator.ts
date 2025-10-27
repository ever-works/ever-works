import { NestFactory } from '@nestjs/core';
import { Directory } from '@src/entities';
import {
    CreateItemsGeneratorDto,
    ExistingItems,
    ItemsGeneratorService,
} from '@src/items-generator';
import { AgentModule } from '@src/services';
import { task } from '@trigger.dev/sdk';

export type Payload = {
    directory: Directory;
    dto: CreateItemsGeneratorDto;
    existing?: ExistingItems;
};

export const helloWorldTask = task({
    id: 'items-generator',
    // Set an optional maxDuration to prevent tasks from running indefinitely
    maxDuration: 300,
    run: async (payload: Payload, { ctx }) => {
        const appContext = await NestFactory.createApplicationContext(AgentModule);
        const appService = appContext.get(ItemsGeneratorService);
        const response = await appService.generateItems(payload.directory, payload.dto, {
            existingCategories: [],
            existingConfig: {},
            existingItems: [],
            existingTags: [],
        });

        return response;
    },
});
