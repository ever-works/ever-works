import {
    BadRequestException,
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    AgentEmailAssignmentRepository,
    AgentRepository,
    TenantEmailAddressRepository,
} from '@ever-works/agent/database';
import type {
    AgentEmailAssignment,
    AgentEmailAssignmentDirection,
    AgentEmailDispatchMode,
} from '@ever-works/agent/entities';

const DIRECTIONS: readonly AgentEmailAssignmentDirection[] = ['outbound', 'inbound'];
const DISPATCH_MODES: readonly AgentEmailDispatchMode[] = ['task-spawn', 'conversation'];

export class CreateAgentEmailAssignmentDto {
    @ApiProperty({ description: 'One of your email addresses.' })
    @IsUUID()
    emailAddressId!: string;

    @ApiProperty({ enum: DIRECTIONS as unknown as string[] })
    @IsIn(DIRECTIONS as unknown as string[])
    direction!: AgentEmailAssignmentDirection;

    @ApiPropertyOptional({
        description:
            'Lower wins. The lowest outbound assignment is the address the Agent sends from.',
        default: 100,
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(10_000)
    priority?: number;

    @ApiPropertyOptional({
        description: 'How inbound mail reaches the Agent. Ignored for outbound.',
        enum: DISPATCH_MODES as unknown as string[],
    })
    @IsOptional()
    @IsIn(DISPATCH_MODES as unknown as string[])
    dispatchMode?: AgentEmailDispatchMode;
}

export interface AgentEmailAssignmentView {
    id: string;
    agentId: string;
    emailAddressId: string;
    address: string | null;
    direction: AgentEmailAssignmentDirection;
    priority: number;
    dispatchMode: AgentEmailDispatchMode;
    createdAt: string;
}

/**
 * Agent email (AW-05) — the missing write path for `agent_email_assignments`
 * (which address an Agent sends from and receives at). The table has been
 * read by the send path and the inbound dispatcher since it shipped, but
 * nothing outside direct SQL could write it.
 *
 * Owner-scoped on BOTH halves: the Agent and the address must each belong
 * to the caller, and a foreign id of either is the same 404 as a missing
 * one. The projection never includes provider settings or verification
 * tokens — only the address string.
 */
@Injectable()
export class AgentEmailAssignmentsService {
    constructor(
        private readonly assignments: AgentEmailAssignmentRepository,
        private readonly addresses: TenantEmailAddressRepository,
        private readonly agents: AgentRepository,
    ) {}

    async list(userId: string, agentId: string): Promise<AgentEmailAssignmentView[]> {
        await this.requireOwnedAgent(userId, agentId);
        const rows = await this.assignments.findByAgent(agentId);
        return rows
            .filter((row) => !row.emailAddress || row.emailAddress.userId === userId)
            .map(toView);
    }

    async create(
        userId: string,
        agentId: string,
        input: CreateAgentEmailAssignmentDto,
    ): Promise<AgentEmailAssignmentView> {
        await this.requireOwnedAgent(userId, agentId);
        const address = await this.addresses.findByIdForUser(input.emailAddressId, userId);
        if (!address) throw new NotFoundException('Email address not found');
        if (address.direction !== 'both' && address.direction !== input.direction) {
            throw new BadRequestException(
                `This address is ${address.direction}-only and cannot be assigned for ${input.direction} mail.`,
            );
        }
        const existing = await this.assignments.findByAgent(agentId, input.direction);
        if (existing.some((row) => row.emailAddressId === address.id)) {
            throw new ConflictException('This address is already assigned to this agent.');
        }
        const saved = await this.assignments.save(
            this.assignments.create({
                agentId,
                emailAddressId: address.id,
                direction: input.direction,
                priority: input.priority ?? 100,
                dispatchMode: input.dispatchMode ?? 'task-spawn',
            }),
        );
        return toView({ ...saved, emailAddress: address } as AgentEmailAssignment);
    }

    async remove(userId: string, id: string): Promise<void> {
        const row = await this.assignments.findById(id);
        if (!row) throw new NotFoundException('Assignment not found');
        const agent = await this.agents.findByIdAndUser(row.agentId, userId);
        if (!agent) throw new NotFoundException('Assignment not found');
        await this.assignments.delete(row.id);
    }

    private async requireOwnedAgent(userId: string, agentId: string): Promise<void> {
        const agent = await this.agents.findByIdAndUser(agentId, userId);
        if (!agent) throw new NotFoundException('Agent not found');
    }
}

function toView(row: AgentEmailAssignment): AgentEmailAssignmentView {
    return {
        id: row.id,
        agentId: row.agentId,
        emailAddressId: row.emailAddressId,
        address: row.emailAddress?.address ?? null,
        direction: row.direction,
        priority: row.priority,
        dispatchMode: row.dispatchMode,
        createdAt: new Date(row.createdAt).toISOString(),
    };
}
