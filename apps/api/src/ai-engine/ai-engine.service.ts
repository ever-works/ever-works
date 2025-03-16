import { Injectable } from '@nestjs/common';
import { Agent, ItemGeneratedSchema } from './agent';
import { Directory } from '../entities/directory.entity';
import slugify from 'slugify';
import { z } from 'zod';

export interface Identifable {
    id: string;
    name: string;
}

export interface Category extends Identifable {
    description?: string;
    icon_url?: string;
}

export interface Tag extends Identifable { }

export interface ItemData {
    name: string;
    description: string;
    featured?: boolean;
    source_url: string;
    category: string | string[] | Category | Category[];
    slug?: string;
    tags: string[] | Tag[];
}

@Injectable()
export class AiEngineService {
    constructor(private readonly agent: Agent) { }

    private mapUnique(names: string[]): Array<Identifable> {
        const unique = new Set(names);
        return Array.from(unique).map(name => ({ id: slugify(name, { lower: true, trim: true }), name }));
    }

    private toItemData(item: z.infer<typeof ItemGeneratedSchema>): ItemData {
        return {
            name: item.name,
            description: item.description,
            source_url: item.source_url,
            category: slugify(item.category, { lower: true, trim: true }),
            tags: item.tags.map(tag => slugify(tag, { lower: true, trim: true })),
            slug: slugify(item.name, { lower: true, trim: true }),
        };
    }

    async getItemsList(directory: Directory, prompt: string) {
        const items = await this.agent.generateItems(directory.id, prompt);
        const categories: Category[] = this.mapUnique(items.map(item => item.category));
        const tags: Tag[] = this.mapUnique(items.flatMap(item => item.tags));

        return { items: items.map(this.toItemData), categories, tags };
    }

    getItemDetails(item: ItemData) {
        return this.agent.generateMarkdown(item);
    }
}
