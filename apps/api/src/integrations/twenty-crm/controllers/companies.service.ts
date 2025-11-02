import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ClientService } from "../services/client.service";
import { JwtAuthGuard } from "@src/auth/guards/jwt-auth.guard";
import { TwentyOrganization } from "../types/twenty-crm.types";

@Controller('api/twenty-crm/companies')
@UseGuards(JwtAuthGuard)
export class CompaniesController {
    constructor(private readonly clientService: ClientService) {}

    @Get()
    async getCompanies() {
        return this.clientService.getCompanies();
    }

    @Post()
    async createCompany(@Body() company: TwentyOrganization) {
        return this.clientService.createCompany(company);
    }

    @Patch(':id')
    async updateCompany(@Param('id') id: string, @Body() company: TwentyOrganization) {
        return this.clientService.updateCompany(id, company);
    }

    @Delete(':id')
    async deleteCompany(@Param('id') id: string) {
        return this.clientService.deleteCompany(id);
    }
}