import assert from "node:assert/strict";
import test from "node:test";
import {
  FinalResultSourceError,
  parseFinalResultRequest,
  resolveFinalResult,
  type SettleTraceService,
} from "../app/lib/final-result-service.ts";
import { hashCanonicalReceipt } from "../app/lib/fan-verification.ts";

async function resolutionPayload(args: {
  fixtureId: number;
  participant1: string;
  participant2: string;
  selection: "participant1" | "draw" | "participant2";
  participant1Goals: number;
  participant2Goals: number;
  outcome: "WIN" | "LOSE";
}) {
  const canonicalSelection =
    args.selection === "participant1"
      ? "home"
      : args.selection === "participant2"
        ? "away"
        : "draw";
  const canonicalBody = {
    version: "settletrace-receipt-v1",
    fixture: {
      id: String(args.fixtureId),
      homeTeam: args.participant1,
      awayTeam: args.participant2,
    },
    predicate: { type: "match_winner", selection: canonicalSelection },
    seq: 17,
    statKeys: [1, 2],
    statValues: { "1": args.participant1Goals, "2": args.participant2Goals },
    finality: { action: "game_finalised", gameFinalised: true, gateSatisfied: true },
    proofStatus: "VERIFIED",
    outcome: args.outcome,
    reasonCodes: ["FINALITY_CONFIRMED", "PROOF_VERIFIED"],
  };
  const receiptHash = await hashCanonicalReceipt(canonicalBody);
  return {
    configured: true,
    mode: "authenticated-resolution",
    fixture: {
      fixtureId: args.fixtureId,
      participant1: args.participant1,
      participant2: args.participant2,
      participant1IsHome: true,
    },
    market: { type: "match_winner", selection: args.selection },
    score: {
      participant1Goals: args.participant1Goals,
      participant2Goals: args.participant2Goals,
    },
    proof: { status: "VERIFIED_ONCHAIN" },
    onChain: { verified: true, verificationMode: "live-view" },
    state: "RESOLVED",
    outcome: args.outcome,
    receipt: {
      receiptHash,
      fixtureId: args.fixtureId,
      outcome: args.outcome,
      scoreSequence: 17,
    },
    consumer: {
      ready: true,
      status: "LIVE_VIEW_VERIFIED",
      receipt: {
        hashAlgorithm: "SHA-256",
        canonicalization: "settletrace-recursive-key-sort-v1",
        receiptHash,
        canonicalBody,
      },
      oracle: { predicateResult: args.outcome === "WIN", verificationMode: "live-view" },
      execution: { transactionSubmitted: false },
    },
  };
}

function pendingPayload(fixtureId: number) {
  return {
    configured: true,
    mode: "authenticated-resolution",
    fixture: {
      fixtureId,
      participant1: "Alpha",
      participant2: "Beta",
      participant1IsHome: true,
    },
    market: { type: "match_winner", selection: "participant1" },
    score: { participant1Goals: null, participant2Goals: null },
    proof: { status: "UNAVAILABLE" },
    onChain: { verified: false, verificationMode: "unverified" },
    state: "OPEN",
    outcome: null,
    receipt: null,
    consumer: null,
  };
}

test("rejects malformed fixture input before contacting the evidence service", () => {
  assert.equal(
    parseFinalResultRequest(
      new URL("https://fanpulse.example/api/final-result?fixtureId=nope"),
    ),
    null,
  );
  assert.deepEqual(
    parseFinalResultRequest(
      new URL("https://fanpulse.example/api/final-result?example=completed"),
    ),
    { fixtureId: 18_179_550, example: true },
  );
});

test("returns a fail-closed pending final-result state", async () => {
  const service: SettleTraceService = {
    fetch: async () => new Response(JSON.stringify(pendingPayload(42)), { status: 200 }),
  };
  const body = await resolveFinalResult({ fixtureId: 42, example: false }, service);
  assert.equal(body.verification.status, "waiting");
  assert.equal(body.verification.receiptHash, null);
});

test("retries the resolved market with the actual winner and returns only the verified summary", async () => {
  const first = await resolutionPayload({
    fixtureId: 42,
    participant1: "Alpha",
    participant2: "Beta",
    selection: "participant1",
    participant1Goals: 1,
    participant2Goals: 2,
    outcome: "LOSE",
  });
  const second = await resolutionPayload({
    fixtureId: 42,
    participant1: "Alpha",
    participant2: "Beta",
    selection: "participant2",
    participant1Goals: 1,
    participant2Goals: 2,
    outcome: "WIN",
  });
  const calls: string[] = [];
  const redirectModes: RequestRedirect[] = [];
  const service: SettleTraceService = {
    fetch: async (request) => {
      const url = new URL(request.url);
      calls.push(url.searchParams.get("selection") ?? "");
      redirectModes.push(request.redirect);
      return new Response(JSON.stringify(calls.length === 1 ? first : second), {
        status: 200,
      });
    },
  };
  const body = await resolveFinalResult({ fixtureId: 42, example: false }, service);
  assert.deepEqual(calls, ["participant1", "participant2"]);
  assert.deepEqual(redirectModes, ["manual", "manual"]);
  assert.equal(body.verification.status, "verified");
  assert.equal(body.verification.winner, "participant2");
  assert.match(body.verification.receiptHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(
    body.verification.evidenceUrl,
    /^https:\/\/settletrace\.oddpulse-txline-2026\.workers\.dev\//,
  );
  assert.doesNotMatch(JSON.stringify(body), /canonicalBody|transactionSubmitted|accountMetas/);
});

test("does not expose upstream failures through the service boundary", async () => {
  const service: SettleTraceService = {
    fetch: async () => {
      throw new Error("upstream secret detail");
    },
  };
  await assert.rejects(
    () => resolveFinalResult({ fixtureId: 42, example: false }, service),
    (error: unknown) => {
      assert.ok(error instanceof FinalResultSourceError);
      assert.equal(error.stage, "INITIAL_RESOLUTION");
      assert.doesNotMatch(error.message, /secret detail/);
      return true;
    },
  );
});
