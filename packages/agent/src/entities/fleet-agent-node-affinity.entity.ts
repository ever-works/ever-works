import {
    Column,
    CreateDateColumn,
    Entity,
    Index,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
} from 'typeorm';

/**
 * Durable owner intent selecting the user-owned Fleet node for one
 * Organization Agent. The selected node is snapshotted onto future jobs;
 * this row is never consulted to retarget work already in the queue.
 */
@Entity({ name: 'fleet_agent_node_affinities' })
@Index('uq_fleet_agent_node_affinity_scope', ['userId', 'organizationId', 'agentId'], {
    unique: true,
})
@Index('idx_fleet_agent_node_affinity_node', ['userId', 'nodeId'])
export class FleetAgentNodeAffinity {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    userId: string;

    @Column({ type: 'uuid' })
    organizationId: string;

    @Column({ type: 'uuid' })
    agentId: string;

    @Column({ type: 'uuid' })
    nodeId: string;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
