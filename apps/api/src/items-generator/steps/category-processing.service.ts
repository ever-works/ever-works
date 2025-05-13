import { Injectable, Logger } from '@nestjs/common';
import { CreateItemsGeneratorDto } from '../dto/create-items-generator.dto';
import { categorize } from '../../agent/categorize';
import { slugifyText } from '../utils/text.utils';
import { ItemData } from '../dto';

@Injectable()
export class CategoryProcessingService {
  private readonly logger = new Logger(CategoryProcessingService.name);

  async processCategoriesAndTags(
    createItemsGeneratorDto: CreateItemsGeneratorDto,
    extractedItems: Partial<ItemData>[],
  ) {
    const { description } = createItemsGeneratorDto;

    const categorized = await categorize(
      description,
      extractedItems.map((i) => ({
        slug: i.slug,
        name: i.name,
        description: i.description,
        url: i.source_url,
      })),
    );

    this.logger.log(`Categorized items: ${categorized.length}`);
    const categories = this.mapUnique(
      categorized.map((item) => item.category as string),
    );
    const tags = this.mapUnique(
      categorized.flatMap((item) => item.tags as string[]),
    );

    return {
      finalItems: categorized.map(this.toItemData),
      categories,
      tags,
    };
  }

  private mapUnique(names: string[]) {
    const unique = new Set(names);
    return Array.from(unique).map((name) => ({
      id: slugifyText(name),
      name,
    }));
  }

  private toItemData(item: Partial<ItemData>): ItemData {
    return {
      name: item.name,
      description: item.description,
      source_url: item.source_url,
      category: slugifyText(item.category as string),
      tags: item.tags.map((tag) => slugifyText(tag)),
      slug: item.slug || slugifyText(item.name),
    };
  }
}
