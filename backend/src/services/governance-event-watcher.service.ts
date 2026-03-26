/**
 * Governance Event Watcher Service
 *
 * Monitors the Stellar network for governance-related contract events:
 * - ts_init  → records a new PendingTreasurySplit as a Disbursement (PENDING)
 * - ts_exec  → marks the Disbursement as EXECUTED
 * - VetoSignal → marks the Disbursement as CANCELLED_BY_GOVERNANCE
 */

import { SorobanRpc } from "@stellar/stellar-sdk";
import { prisma } from "../lib/db.js";
import { logger } from "../logger.js";

const GOVERNANCE_EVENTS = ["ts_init", "ts_exec", "VetoSignal"] as const;
type GovernanceEventType = (typeof GOVERNANCE_EVENTS)[number];

interface RawGovernanceEvent {
  type: GovernanceEventType;
  splitId: bigint;
  initiator?: string;
  token?: string;
  recipients?: string[];
  amounts?: string[];
  unlockTime?: bigint;
  txHash: string;
  ledger: number;
}

export class GovernanceEventWatcher {
  private readonly rpcServer: SorobanRpc.Server;
  private readonly contractId: string;
  private readonly pollIntervalMs: number;
  private timer?: NodeJS.Timeout;
  private lastLedger = 0;

  constructor() {
    const rpcUrl =
      process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
    this.contractId = process.env.CONTRACT_ID ?? "";
    this.pollIntervalMs = Number(
      process.env.GOVERNANCE_WATCHER_INTERVAL_MS ?? "10000"
    );
    this.rpcServer = new SorobanRpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith("http://"),
    });
  }

  start(): void {
    if (this.timer) return;
    logger.info("GovernanceEventWatcher started", {
      contractId: this.contractId,
      pollIntervalMs: this.pollIntervalMs,
    });
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    void this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info("GovernanceEventWatcher stopped");
    }
  }

  private async poll(): Promise<void> {
    if (!this.contractId) return;

    try {
      const latestLedger = await this.rpcServer.getLatestLedger();
      const startLedger = this.lastLedger > 0 ? this.lastLedger + 1 : latestLedger.sequence - 100;

      const response = await this.rpcServer.getEvents({
        startLedger,
        filters: [
          {
            type: "contract",
            contractIds: [this.contractId],
            topics: [
              GOVERNANCE_EVENTS.map((e) => `"${e}"`),
            ],
          },
        ],
        limit: 200,
      });

      for (const event of response.events) {
        await this.handleEvent(event);
      }

      this.lastLedger = latestLedger.sequence;
    } catch (error) {
      logger.error("GovernanceEventWatcher poll error", { error });
    }
  }

  private async handleEvent(event: SorobanRpc.Api.EventResponse): Promise<void> {
    try {
      const topicStr = event.topic[0]?.toString() ?? "";
      const eventType = GOVERNANCE_EVENTS.find((t) => topicStr.includes(t));
      if (!eventType) return;

      const parsed = this.parseEvent(eventType, event);
      if (!parsed) return;

      switch (eventType) {
        case "ts_init":
          await this.handleTreasuryInit(parsed);
          break;
        case "ts_exec":
          await this.handleTreasuryExec(parsed);
          break;
        case "VetoSignal":
          await this.handleVetoSignal(parsed);
          break;
      }
    } catch (error) {
      logger.error("GovernanceEventWatcher: failed to handle event", { error, eventId: event.id });
    }
  }

  /**
   * ts_init — a new treasury split was initiated; record it as PENDING.
   */
  private async handleTreasuryInit(event: RawGovernanceEvent): Promise<void> {
    await prisma.disbursement.upsert({
      where: { splitId: event.splitId },
      update: {},
      create: {
        splitId: event.splitId,
        initiator: event.initiator ?? "",
        token: event.token ?? "",
        recipients: JSON.stringify(event.recipients ?? []),
        amounts: JSON.stringify(event.amounts ?? []),
        unlockTime: event.unlockTime ?? 0n,
        status: "PENDING",
        txHash: event.txHash,
        ledger: event.ledger,
      },
    });

    logger.info("GovernanceEventWatcher: treasury split initiated", {
      splitId: event.splitId.toString(),
    });
  }

  /**
   * ts_exec — the split was executed after the timelock; mark as EXECUTED.
   */
  private async handleTreasuryExec(event: RawGovernanceEvent): Promise<void> {
    await prisma.disbursement.updateMany({
      where: { splitId: event.splitId, status: "PENDING" },
      data: { status: "EXECUTED", txHash: event.txHash, ledger: event.ledger },
    });

    logger.info("GovernanceEventWatcher: treasury split executed", {
      splitId: event.splitId.toString(),
    });
  }

  /**
   * VetoSignal — community veto detected; cancel the pending split.
   */
  private async handleVetoSignal(event: RawGovernanceEvent): Promise<void> {
    await prisma.disbursement.updateMany({
      where: { splitId: event.splitId, status: "PENDING" },
      data: {
        status: "CANCELLED_BY_GOVERNANCE",
        txHash: event.txHash,
        ledger: event.ledger,
      },
    });

    logger.info("GovernanceEventWatcher: veto signal received — split cancelled", {
      splitId: event.splitId.toString(),
    });
  }

  private parseEvent(
    type: GovernanceEventType,
    event: SorobanRpc.Api.EventResponse
  ): RawGovernanceEvent | null {
    try {
      // topic[1] carries the split_id for all three event types
      const splitIdRaw = event.topic[1]?.toString() ?? "0";
      const splitId = BigInt(splitIdRaw.replace(/[^0-9]/g, "") || "0");

      const base: RawGovernanceEvent = {
        type,
        splitId,
        txHash: event.txHash,
        ledger: event.ledger,
      };

      // For ts_init the value XDR carries initiator + token + unlock_time
      if (type === "ts_init" && event.value) {
        const val = event.value.toString();
        // Best-effort: extract fields from the decoded JSON if available
        try {
          const decoded = JSON.parse(val) as Record<string, unknown>;
          base.initiator = String(decoded.initiator ?? "");
          base.token = String(decoded.token ?? "");
          base.unlockTime = BigInt(String(decoded.unlock_time ?? "0"));
          base.recipients = (decoded.recipients as string[]) ?? [];
          base.amounts = (decoded.amounts as string[]) ?? [];
        } catch {
          // XDR not JSON-decoded; leave fields empty — they'll be filled on exec
        }
      }

      return base;
    } catch {
      return null;
    }
  }
}
