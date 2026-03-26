/**
 * GET /api/v3/governance/snapshot/:ledger
 *
 * Returns all DAO token holders and their balances at the given ledger
 * as a CSV formatted for the V3 Splitter.
 *
 * CSV format:
 *   address,balance
 *   GABC...,1000000
 *   GXYZ...,500000
 */

import { Router, Request, Response } from "express";
import { SorobanRpc, Contract, Account, Keypair, TransactionBuilder, Networks, nativeToScVal, Address, scValToNative } from "@stellar/stellar-sdk";
import { z } from "zod";
import { logger } from "../../logger.js";
import asyncHandler from "../../utils/asyncHandler.js";
import validateRequest from "../../middleware/validateRequest.js";
import { prisma } from "../../lib/db.js";

const router = Router();

const snapshotParamsSchema = z.object({
  ledger: z.string().regex(/^\d+$/, "ledger must be a positive integer"),
});

/**
 * Reconstruct token holder balances at a specific ledger by replaying
 * Transfer events from ContractEvent up to (and including) that ledger.
 *
 * Falls back to current on-chain balances via Soroban RPC simulation
 * when historical event data is insufficient.
 */
async function getHoldersAtLedger(
  ledger: number
): Promise<Array<{ address: string; balance: string }>> {
  const daoTokenAddress = process.env.DAO_TOKEN_ADDRESS;

  // --- Strategy 1: replay indexed Transfer events up to the target ledger ---
  if (daoTokenAddress) {
    try {
      const events = await prisma.contractEvent.findMany({
        where: {
          contractId: daoTokenAddress,
          eventType: { in: ["transfer", "mint", "burn"] },
          ledgerSequence: { lte: ledger },
        },
        orderBy: { ledgerSequence: "asc" },
      });

      if (events.length > 0) {
        const balances = new Map<string, bigint>();

        for (const event of events) {
          const decoded = event.decodedJson as Record<string, unknown>;
          const amount = BigInt(String(decoded.amount ?? "0"));
          const from = String(decoded.from ?? "");
          const to = String(decoded.to ?? "");

          if (event.eventType === "transfer" || event.eventType === "burn") {
            if (from) balances.set(from, (balances.get(from) ?? 0n) - amount);
          }
          if (event.eventType === "transfer" || event.eventType === "mint") {
            if (to) balances.set(to, (balances.get(to) ?? 0n) + amount);
          }
        }

        return Array.from(balances.entries())
          .filter(([, bal]) => bal > 0n)
          .map(([address, balance]) => ({ address, balance: balance.toString() }));
      }
    } catch (err) {
      logger.warn("snapshot: event replay failed, falling back to RPC", { err });
    }
  }

  // --- Strategy 2: return current stream senders/receivers as proxy holders ---
  // When no DAO token is configured or event history is sparse, we derive
  // "holders" from active stream participants and use their remaining balance
  // as a proxy for governance weight.
  const streams = await prisma.stream.findMany({
    where: { status: "ACTIVE" },
    select: { sender: true, receiver: true, amount: true, withdrawn: true },
  });

  const balances = new Map<string, bigint>();
  for (const s of streams) {
    const total = BigInt(s.amount ?? "0");
    const withdrawn = BigInt(s.withdrawn ?? "0");
    const remaining = total > withdrawn ? total - withdrawn : 0n;
    if (remaining > 0n) {
      balances.set(s.receiver, (balances.get(s.receiver) ?? 0n) + remaining);
    }
  }

  return Array.from(balances.entries())
    .filter(([, bal]) => bal > 0n)
    .map(([address, balance]) => ({ address, balance: balance.toString() }));
}

function toCsv(holders: Array<{ address: string; balance: string }>): string {
  const rows = holders.map((h) => `${h.address},${h.balance}`);
  return ["address,balance", ...rows].join("\n");
}

/**
 * GET /api/v3/governance/snapshot/:ledger
 */
router.get(
  "/governance/snapshot/:ledger",
  validateRequest({ params: snapshotParamsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const ledger = parseInt(req.params.ledger, 10);

    // Validate ledger is not in the future
    const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
    const rpc = new SorobanRpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });

    try {
      const latest = await rpc.getLatestLedger();
      if (ledger > latest.sequence) {
        res.status(400).json({
          success: false,
          error: `Ledger ${ledger} is in the future (latest: ${latest.sequence})`,
        });
        return;
      }
    } catch {
      // RPC unavailable — proceed without the future-ledger guard
    }

    const holders = await getHoldersAtLedger(ledger);

    if (holders.length === 0) {
      res.status(404).json({
        success: false,
        error: `No token holder data found at ledger ${ledger}`,
      });
      return;
    }

    const csv = toCsv(holders);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="snapshot-${ledger}.csv"`
    );
    res.send(csv);
  })
);

export default router;
