import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DataGeneratorService } from './data-generator/data-generator.service';
import { MarkdownGeneratorService } from './markdown-generator/markdown-generator.service';

@Controller()
export class AppController {
  constructor(
    private readonly dataGenerator: DataGeneratorService,
    private readonly markdownGenerator: MarkdownGeneratorService
  ) {}

  @Post()
  async generateData(
    @Body('name') name: string,
    @Body('title') title: string,
    @Body('description') description: string,
  ) {
    await this.dataGenerator.initialize(name);
    await this.markdownGenerator.initialize({
      name,
      description,
      title
    });

    return { success: true };
  }
}
