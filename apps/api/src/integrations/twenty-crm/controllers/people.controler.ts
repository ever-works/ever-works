import { Body, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ClientService } from '../services/client.service';
import { TwentyContact } from '../types/twenty-crm.types';

export class PeopleController {
    constructor(private readonly clientService: ClientService) {}

    @Get()
    async getContacts() {
        return this.clientService.getContacts();
    }

    @Post()
    async createContact(@Body() contact: TwentyContact) {
        return await this.clientService.createContact({
            firstName: contact.firstName,
            lastName: contact.lastName,
            email: contact.email,
            phone: contact.phone,
            companyId: contact.companyId,
            position: contact.position,
            avatarUrl: contact.avatarUrl,
        });
    }

    @Patch(':id')
    async updateContact(@Param('id') id: string, @Body() contact: TwentyContact) {
        return this.clientService.updateContact(id, contact);
    }

    @Delete(':id')
    async deleteContact(@Param('id') id: string) {
        return this.clientService.deleteContact(id);
    }
}
