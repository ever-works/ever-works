import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { FleetPortTunnelClosedReason, FleetPortTunnelState } from '@ever-works/contracts';
import { PortableDateColumn } from './_types';

/**
 * Servers and ports, phase 2 (FL-10, CONTRACTS §4.9, R-17) — one preview
 * tunnel: a time-boxed grant for ONE person to reach ONE port on ONE Node
 * through their own browser, at `https://<previewHost>/p/<id>/…`.
 *
 * A grant, not a machine fact and not history (README §1): the open and close
 * `fleet_audit` rows keep the history (`auditOpenId`, `auditCloseId`); this
 * row exists so a tunnel survives an API restart and can be listed and closed.
 *
 * Columns are exactly CONTRACTS §4.9 (revision 4): `closedReason` is one of
 * `idle · hard · user · node-offline · kill-switch · drain · link-closed`,
 * validated in code (CONTRACTS §4 storage note — plain `varchar`, no enum);
 * the hard cap is `openedAt` + 60 min (no stored expiry); `requestCount`,
 * `bytesIn` (toward the machine) and `bytesOut` (toward the browser) are
 * advanced by the replica that served the requests.
 *
 * Written ONLY by `FleetPortTunnelService` (open, touch, close) and its
 * sweeper. Scope columns are raw uuids (no `@ManyToOne`, the entity-cycle
 * rule); the foreign keys live in the migration
 * (`1796100000000-CreateFleetPortTunnels`). Registered in
 * `database/_entities-inventory.ts` and `_entity-names.ts`.
 */
@Entity({ name: 'fleet_port_tunnels' })
@Index('idx_fleet_port_tunnels_owner_state', ['ownerUserId', 'state'])
@Index('idx_fleet_port_tunnels_node_state', ['nodeId', 'state'])
@Index('idx_fleet_port_tunnels_opened', ['openedAt'])
export class FleetPortTunnel {
    /** The `<tunnelId>` in the preview address. */
    @PrimaryGeneratedColumn('uuid')
    id: string;

    /** The one person who may use it (the opener, or the owner of the Agent that opened it). */
    @Column({ type: 'uuid' })
    ownerUserId: string;

    @Column({ type: 'uuid' })
    nodeId: string;

    /** 1–65535; always reached on `127.0.0.1` on the machine. */
    @Column({ type: 'int' })
    port: number;

    /** The dedicated preview hostname the tunnel was minted for (`FLEET_PREVIEW_HOST`). */
    @Column({ type: 'varchar', length: 255 })
    previewHost: string;

    /** `open` | `closed`. */
    @Column({ type: 'varchar', length: 8, default: 'open' })
    state: FleetPortTunnelState;

    @PortableDateColumn()
    openedAt: Date;

    /** The idle clock: the last request served (null before the first). */
    @PortableDateColumn({ nullable: true })
    lastRequestAt?: Date | null;

    @PortableDateColumn({ nullable: true })
    closedAt?: Date | null;

    @Column({ type: 'varchar', length: 16, nullable: true })
    closedReason?: FleetPortTunnelClosedReason | null;

    /** Requests served (CONTRACTS §4.9 rev 4). */
    @Column({ type: 'int', default: 0 })
    requestCount: number;

    /** Bytes toward the machine. `bigint`: a STRING on Postgres, a number on SQLite — normalised in the view. */
    @Column({ type: 'bigint', default: 0 })
    bytesIn: number | string;

    /** Bytes toward the browser. */
    @Column({ type: 'bigint', default: 0 })
    bytesOut: number | string;

    /** The `node.port.preview.open` audit row. */
    @Column({ type: 'uuid', nullable: true })
    auditOpenId?: string | null;

    /** The `node.port.preview.close` audit row. */
    @Column({ type: 'uuid', nullable: true })
    auditCloseId?: string | null;

    @CreateDateColumn()
    createdAt: Date;

    @UpdateDateColumn()
    updatedAt: Date;
}
