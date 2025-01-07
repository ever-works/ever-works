import { Body, Controller, Post } from '@nestjs/common';
import { DataGeneratorService } from './data-generator/data-generator.service';

@Controller()
export class AppController {
  constructor(private readonly dataGenerator: DataGeneratorService) {}

  @Post()
  async generateData(@Body('name') name: string) {
    await this.dataGenerator.generate(name);
    return { success: true };
  }
}
