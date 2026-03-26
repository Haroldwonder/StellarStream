-- Disbursements table for DAO treasury split tracking
CREATE TABLE IF NOT EXISTS "Disbursement" (
  "id"          TEXT        NOT NULL PRIMARY KEY,
  "splitId"     BIGINT      NOT NULL,
  "initiator"   TEXT        NOT NULL,
  "token"       TEXT        NOT NULL,
  "recipients"  TEXT        NOT NULL, -- JSON array
  "amounts"     TEXT        NOT NULL, -- JSON array
  "unlockTime"  BIGINT      NOT NULL,
  "status"      TEXT        NOT NULL DEFAULT 'PENDING',
  "txHash"      TEXT,
  "ledger"      INTEGER,
  "createdAt"   TIMESTAMP   NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "Disbursement_status_idx" ON "Disbursement" ("status");
CREATE INDEX IF NOT EXISTS "Disbursement_splitId_idx" ON "Disbursement" ("splitId");
CREATE INDEX IF NOT EXISTS "Disbursement_initiator_idx" ON "Disbursement" ("initiator");
