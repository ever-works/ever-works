import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
    IsBoolean,
    IsInt,
    IsOptional,
    IsString,
    IsUrl,
    Max,
    MaxLength,
    Min,
} from 'class-validator';
import { ClientService } from '../services/client.service';
import { AuthSessionGuard } from '@src/auth/guards/auth-session.guard';
import { TwentyOrganization } from '../types/twenty-crm.types';

// Security: explicit class-validator DTOs so the global ValidationPipe
// (whitelist + forbidNonWhitelisted + transform) actually applies. The
// previous `@Body() company: TwentyOrganization` typed the body as an
// erased TS interface (runtime type `Object`), so no fields were
// whitelisted or type-checked — letting callers forward arbitrary extra
// keys, oversized strings, and wrong-typed values straight to the CRM API.
// These DTOs are structurally assignable to TwentyOrganization, so legitimate
// payloads are unchanged; only unknown/malformed fields are now rejected.
class CompanyBodyDto {
    @IsString()
    @MaxLength(255)
    name: string;

    @IsOptional()
    @IsString()
    @MaxLength(255)
    domainName?: string;

    @IsOptional()
    @IsString()
    @MaxLength(1024)
    address?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(10_000_000)
    employees?: number;

    @IsOptional()
    @IsString()
    @IsUrl()
    @MaxLength(2048)
    linkedinUrl?: string;

    @IsOptional()
    @IsString()
    @IsUrl()
    @MaxLength(2048)
    xUrl?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    annualRecurringRevenue?: number;

    @IsOptional()
    @IsBoolean()
    idealCustomerProfile?: boolean;
}

@Controller('api/twenty-crm/companies')
@UseGuards(AuthSessionGuard)
export class CompaniesController {
    constructor(private readonly clientService: ClientService) {}

    @Get()
    async getCompanies() {
        return this.clientService.getCompanies();
    }

    @Post()
    async createCompany(@Body() company: CompanyBodyDto): Promise<TwentyOrganization> {
        return this.clientService.createCompany(company);
    }

    @Patch(':id')
    async updateCompany(
        @Param('id') id: string,
        @Body() company: CompanyBodyDto,
    ): Promise<TwentyOrganization> {
        return this.clientService.updateCompany(id, company);
    }

    @Delete(':id')
    async deleteCompany(@Param('id') id: string) {
        return this.clientService.deleteCompany(id);
    }
}
