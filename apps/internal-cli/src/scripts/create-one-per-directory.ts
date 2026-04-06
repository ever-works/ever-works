import { NestFactory } from '@nestjs/core';
import { CLIModule } from '../cli.module';
import { DirectoryRepository, UserRepository } from '@ever-works/agent/database';
import { DirectoryGenerationService } from '@ever-works/agent/services';
import { CreateItemsGeneratorDto, GenerationMethod } from '@ever-works/agent/items-generator';

async function main() {
    const app = await NestFactory.createApplicationContext(CLIModule, { logger: false });
    try {
        const directoryRepo = app.get(DirectoryRepository);
        const generationService = app.get(DirectoryGenerationService);
        const userRepo = app.get(UserRepository);

        const user = await userRepo.createOrGetLocalUser();

        const dirs = await directoryRepo.findAll();

        console.log(`Found ${dirs.length} directories. Dispatching one generation job per directory...`);

        for (const d of dirs) {
            try {
                const dto: CreateItemsGeneratorDto = {
                    name: `Auto item for ${d.slug || d.id}`,
                    prompt: 'Generate one short descriptive item for this directory.',
                    generation_method: GenerationMethod.CREATE_UPDATE,
                };

                await generationService.generateItems(d.id, dto, user, false);
                console.log(`Dispatched generation for ${d.slug || d.id}`);
            } catch (err) {
                console.error(`Failed to dispatch for ${d.slug || d.id}:`, err?.message || err);
            }
        }
    } catch (e) {
        console.error('Script error:', e);
        process.exitCode = 1;
    } finally {
        await app.close();
    }
}

main();
