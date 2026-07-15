import assert from "node:assert/strict";
import test from "node:test";
import {
  finalWinner,
  hashCanonicalReceipt,
  normalizeFanVerification,
  receiptSelection,
  verifySettleTraceReceiptIntegrity,
} from "../app/lib/fan-verification.ts";

const urls = ["https://evidence.example/api", "https://product.example/"] as const;

function verifiedPayload(overrides: Record<string, unknown> = {}) {
  return {
    fixture: { fixtureId: 42, participant1: "Alpha", participant2: "Beta" },
    market: { selection: "participant1" },
    score: { participant1Goals: 3, participant2Goals: 2 },
    proof: { status: "VERIFIED_ONCHAIN" },
    onChain: { verified: true, verificationMode: "live-view" },
    state: "RESOLVED",
    outcome: "WIN",
    receipt: { receiptHash: "abc123", scoreSequence: 17, issuedAt: "2026-07-01T00:00:00Z" },
    consumer: { ready: true, status: "LIVE_VIEW_VERIFIED" },
    ...overrides,
  };
}

test("maps FanPulse outcome keys to SettleTrace selections", () => {
  assert.equal(receiptSelection("part1"), "participant1");
  assert.equal(receiptSelection("participant2"), "participant2");
  assert.equal(receiptSelection("draw"), "draw");
  assert.equal(receiptSelection("over"), null);
});

test("derives the final winner only from a resolved score", () => {
  assert.equal(finalWinner(verifiedPayload()), "participant1");
  assert.equal(
    finalWinner(verifiedPayload({ score: { participant1Goals: 1, participant2Goals: 1 } })),
    "draw",
  );
  assert.equal(
    finalWinner(verifiedPayload({ score: { participant1Goals: 0, participant2Goals: 2 } })),
    "participant2",
  );
  assert.equal(finalWinner(verifiedPayload({ state: "OPEN" })), null);
});

test("issues a verified fan result only when receipt, proof, and consumer gate agree", () => {
  const result = normalizeFanVerification(verifiedPayload(), ...urls, true);
  assert.ok(result);
  assert.equal(result.status, "verified");
  assert.equal(result.score, "3 — 2");
  assert.equal(result.outcome, "WIN");
  assert.equal(result.winner, "participant1");
  assert.equal(result.receiptHash, "abc123");
});

test("recomputes and verifies the SettleTrace canonical receipt hash", async () => {
  const canonicalBody = {
    version: "settletrace-receipt-v1",
    fixture: { id: "42", homeTeam: "Alpha", awayTeam: "Beta" },
    predicate: { type: "match_winner", selection: "home" },
    seq: 17,
    statKeys: [1, 2],
    statValues: { "1": 3, "2": 2 },
    finality: { action: "game_finalised", gameFinalised: true, gateSatisfied: true },
    proofStatus: "VERIFIED",
    outcome: "WIN",
    reasonCodes: ["PROOF_VERIFIED", "PREDICATE_MATCHED"],
  };
  const receiptHash = await hashCanonicalReceipt(canonicalBody);
  const payload = {
    ...verifiedPayload(),
    configured: true,
    mode: "authenticated-resolution",
    fixture: {
      fixtureId: 42,
      participant1: "Alpha",
      participant2: "Beta",
      participant1IsHome: true,
    },
    receipt: { receiptHash, fixtureId: 42, outcome: "WIN", scoreSequence: 17 },
    consumer: {
      ready: true,
      status: "LIVE_VIEW_VERIFIED",
      receipt: {
        hashAlgorithm: "SHA-256",
        canonicalization: "settletrace-recursive-key-sort-v1",
        receiptHash,
        canonicalBody,
      },
      oracle: { predicateResult: true, verificationMode: "live-view" },
      execution: { transactionSubmitted: false },
    },
  };
  assert.equal(await verifySettleTraceReceiptIntegrity(payload), true);
  assert.equal(
    await verifySettleTraceReceiptIntegrity({
      ...payload,
      receipt: { receiptHash: "tampered", fixtureId: 42, outcome: "WIN", scoreSequence: 17 },
    }),
    false,
  );
});

test("fails closed while the market is open", () => {
  const result = normalizeFanVerification(
    verifiedPayload({
      state: "OPEN",
      outcome: null,
      proof: { status: "UNAVAILABLE" },
      onChain: { verified: false, verificationMode: "unverified" },
      receipt: null,
      consumer: null,
    }),
    ...urls,
  );
  assert.ok(result);
  assert.equal(result.status, "waiting");
  assert.equal(result.receiptHash, null);
  assert.match(result.message, /will not issue a result badge/);
});

test("does not label a resolved but unverified response as verified", () => {
  const result = normalizeFanVerification(
    verifiedPayload({
      proof: { status: "PROOF_FETCHED" },
      onChain: { verified: false, verificationMode: "unverified" },
      consumer: { ready: false, status: "UNVERIFIED" },
    }),
    ...urls,
  );
  assert.ok(result);
  assert.equal(result.status, "unverified");
});
