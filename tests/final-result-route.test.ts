import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../app/api/final-result/route.ts";
import { hashCanonicalReceipt } from "../app/lib/fan-verification.ts";

const origin = "https://settletrace-test.example";

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

async function withFetch<T>(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
) {
  const originalFetch = globalThis.fetch;
  const originalOrigin = process.env.SETTLETRACE_ORIGIN;
  globalThis.fetch = handler as typeof fetch;
  process.env.SETTLETRACE_ORIGIN = origin;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOrigin === undefined) delete process.env.SETTLETRACE_ORIGIN;
    else process.env.SETTLETRACE_ORIGIN = originalOrigin;
  }
}

test("rejects malformed fixture input before contacting the evidence source", async () => {
  let calls = 0;
  const response = await withFetch(
    async () => {
      calls += 1;
      return new Response();
    },
    () => GET(new Request("https://fanpulse.example/api/final-result?fixtureId=nope")),
  );
  assert.equal(response.status, 400);
  assert.equal(calls, 0);
  assert.match(await response.text(), /INVALID_FIXTURE/);
});

test("returns a fail-closed pending final-result state", async () => {
  const response = await withFetch(
    async () => new Response(JSON.stringify(pendingPayload(42)), { status: 200 }),
    () => GET(new Request("https://fanpulse.example/api/final-result?fixtureId=42")),
  );
  const body = (await response.json()) as { verification: { status: string; receiptHash: unknown } };
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
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
  const response = await withFetch(
    async (input) => {
      const url = new URL(String(input));
      calls.push(url.searchParams.get("selection") ?? "");
      return new Response(JSON.stringify(calls.length === 1 ? first : second), { status: 200 });
    },
    () => GET(new Request("https://fanpulse.example/api/final-result?fixtureId=42")),
  );
  const body = (await response.json()) as {
    verification: { status: string; winner: string; receiptHash: string };
  };
  assert.deepEqual(calls, ["participant1", "participant2"]);
  assert.equal(body.verification.status, "verified");
  assert.equal(body.verification.winner, "participant2");
  assert.match(body.verification.receiptHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(body), /canonicalBody|transactionSubmitted|accountMetas/);
});

test("hides upstream failures behind a stable public error", async () => {
  const response = await withFetch(
    async () => {
      throw new Error("upstream secret detail");
    },
    () => GET(new Request("https://fanpulse.example/api/final-result?fixtureId=42")),
  );
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /RESULT_SOURCE_UNAVAILABLE/);
  assert.doesNotMatch(body, /secret detail/);
});
