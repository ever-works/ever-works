import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DataGeneratorService, Directory } from './data-generator/data-generator.service';
import { MarkdownGeneratorService } from './markdown-generator/markdown-generator.service';
import { WebsiteGeneratorService } from './website-generator/website-generator.service';
import slugify from 'slugify';

@Controller()
export class AppController {
  constructor(
    private readonly dataGenerator: DataGeneratorService,
    private readonly markdownGenerator: MarkdownGeneratorService,
    private readonly websiteGenerator: WebsiteGeneratorService,
  ) {}

  @Post()
  async generateData(
    @Body('name') name: string,
    @Body('description') description: string,
    @Body('prompt') prompt: string,
    @Body('slug') slug?: string,
  ) {
    const directory: Directory = {
      name,
      description,
      slug: slug || slugify(name, { lower: true, trim: true }),
    };

    await this.dataGenerator.initialize(directory, prompt);
    await this.markdownGenerator.initialize(directory);
    await this.websiteGenerator.initialize(directory.slug);
    return directory;
  }

  @Post('sync')
  async updateData(
    @Body('name') name: string,
    @Body('slug') slug: string,
    @Body('description') description: string,
    @Body('prompt') prompt: string,
  ) {
    const directory: Directory = {
      name,
      description,
      slug,
    };

    await this.dataGenerator.update(directory, prompt);
    await this.markdownGenerator.update(directory);
    return { success: true };
  }
}
