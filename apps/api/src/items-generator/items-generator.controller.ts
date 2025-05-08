import { Controller, Post, Body, ValidationPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { ItemsGeneratorService } from './items-generator.service';
import { CreateItemsGeneratorDto } from './dto/create-awesome-list.dto';
import { ItemsGeneratorResponseDto } from './dto/items-generator-response.dto';

@Controller('awesome-list')
export class ItemsGeneratorController {
  constructor(private readonly ItemsGeneratorService: ItemsGeneratorService) {}

  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED) // Suggesting ACCEPTED as this might be a long-running task
  async generateItemsGenerator(
    @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
    createItemsGeneratorDto: CreateItemsGeneratorDto,
  ): Promise<ItemsGeneratorResponseDto> {
    // Intentionally not awaiting this to allow for an immediate response
    // The actual processing will happen in the background.
    // A more robust solution might involve job queues, webhooks, or websockets for status updates.
    this.ItemsGeneratorService.generateItemsGenerator(createItemsGeneratorDto);

    return {
      status: 'pending',
      slug: createItemsGeneratorDto.slug,
      message: `Processing request for '${createItemsGeneratorDto.name}'. Check logs or data directory for updates.`,
    };
  }
}