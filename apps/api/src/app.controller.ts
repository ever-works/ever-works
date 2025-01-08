import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { DataGeneratorService } from './data-generator/data-generator.service';
import { MarkdownGeneratorService } from './markdown-generator/markdown-generator.service';
import { MarkdownBuilder } from './markdown-generator/markdown-builder';

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

  @Post('sync')
  async syncData(
    @Body('name') name: string,
    @Body('title') title: string,
    @Body('description') description: string,
  ) {
    await this.dataGenerator.update(name);
    await this.markdownGenerator.update({
      name,
      description,
      title
    });
    return { success: true };
  }

  @Get('/markdown')
  buildMd() {
    const builder = new MarkdownBuilder();
    builder
      .h1("Hello world")
      .paragraph("First usage of MarkdownBuilder")

    const people = [ { name: 'Michał' }, { name: 'Paweł' } ];
    builder.startList();
    
    for (const person of people) {
      builder.startListItem();
      builder.link(person.name, 'https://example.com');
      builder.paragraph('Some text')
      builder.end();
    }

    builder.end();
    builder.paragraph("End paragraph");
    return builder.build();
  }
}
