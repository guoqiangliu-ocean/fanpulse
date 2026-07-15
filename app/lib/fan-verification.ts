export type FanVerificationStatus = "verified" | "waiting" | "unverified";
export type MatchWinner = "participant1" | "draw" | "participant2";

export type FanVerification = {
  fixtureId: number;
  fixtureLabel: string;
  winner: MatchWinner | null;
  winnerLabel: string | null;
  score: string | null;
  state: string;
  outcome: "WIN" | "LOSE" | "PUSH" | "VOID" | null;
  status: FanVerificationStatus;
  message: string;
  receiptHash: string | null;
  scoreSequence: number | null;
  proofStatus: string;
  verificationMode: "live-view" | "verified-snapshot" | "unverified";
  consumerReady: boolean;
  consumerStatus: string | null;
  issuedAt: string | null;
  evidenceUrl: string;
  productUrl: string;
};

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};

const text = (value: unknown) => (typeof value === "string" ? value : null);

const integer = (value: unknown) => {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isSafeInteger(number) ? number : null;
};

export function receiptSelection(value: string) {
  const key = value.trim().toLowerCase();
  if (key === "part1" || key === "participant1") return "participant1" as const;
  if (key === "part2" || key === "participant2") return "participant2" as const;
  if (key === "draw") return "draw" as const;
  return null;
}

export function finalWinner(payload: unknown): MatchWinner | null {
  const body = record(payload);
  if (body.state !== "RESOLVED") return null;
  const score = record(body.score);
  const participant1Goals = integer(score.participant1Goals);
  const participant2Goals = integer(score.participant2Goals);
  if (participant1Goals === null || participant2Goals === null) return null;
  return participant1Goals > participant2Goals
    ? "participant1"
    : participant2Goals > participant1Goals
      ? "participant2"
      : "draw";
}

function canonicalJson(
  value: unknown,
  ancestors = new Set<object>(),
  inArray = false,
): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Non-finite receipt value");
    return JSON.stringify(value);
  }
  if (["undefined", "function", "symbol"].includes(typeof value)) {
    return inArray ? "null" : undefined;
  }
  if (typeof value === "bigint") throw new TypeError("BigInt receipt value");
  if (typeof value !== "object") throw new TypeError("Unsupported receipt value");
  if (ancestors.has(value)) throw new TypeError("Cyclic receipt value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => canonicalJson(item, ancestors, true) ?? "null")
        .join(",")}]`;
    }
    const source = value as UnknownRecord;
    const members: string[] = [];
    for (const key of Object.keys(source).sort()) {
      const encoded = canonicalJson(source[key], ancestors, false);
      if (encoded !== undefined) members.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${members.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export async function hashCanonicalReceipt(value: unknown) {
  const canonical = canonicalJson(value);
  if (canonical === undefined) throw new TypeError("Receipt body is missing");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function verifySettleTraceReceiptIntegrity(payload: unknown) {
  try {
    const body = record(payload);
    const fixture = record(body.fixture);
    const score = record(body.score);
    const market = record(body.market);
    const topProof = record(body.proof);
    const onChain = record(body.onChain);
    const receipt = record(body.receipt);
    const consumer = record(body.consumer);
    const consumerReceipt = record(consumer.receipt);
    const canonicalBody = record(consumerReceipt.canonicalBody);
    const canonicalFixture = record(canonicalBody.fixture);
    const canonicalPredicate = record(canonicalBody.predicate);
    const statValues = record(canonicalBody.statValues);
    const oracle = record(consumer.oracle);
    const execution = record(consumer.execution);
    const selection = receiptSelection(text(market.selection) ?? "");
    const winner = finalWinner(body);
    const fixtureId = integer(fixture.fixtureId);
    const expectedPredicateSelection =
      selection === "participant1"
        ? "home"
        : selection === "participant2"
          ? "away"
          : selection;
    const receiptHash = text(receipt.receiptHash);
    const consumerStatus = text(consumer.status);
    const sequence = integer(receipt.scoreSequence);
    const verificationMode = text(onChain.verificationMode);

    if (
      !fixtureId ||
      !selection ||
      !winner ||
      selection !== winner ||
      fixture.participant1IsHome !== true ||
      body.configured !== true ||
      body.mode !== "authenticated-resolution" ||
      body.state !== "RESOLVED" ||
      body.outcome !== "WIN" ||
      topProof.status !== "VERIFIED_ONCHAIN" ||
      onChain.verified !== true ||
      (verificationMode !== "live-view" && verificationMode !== "verified-snapshot") ||
      consumer.ready !== true ||
      (consumerStatus !== "LIVE_VIEW_VERIFIED" &&
        consumerStatus !== "SNAPSHOT_HASH_VERIFIED") ||
      consumerReceipt.hashAlgorithm !== "SHA-256" ||
      consumerReceipt.canonicalization !== "settletrace-recursive-key-sort-v1" ||
      !receiptHash ||
      !/^[a-f0-9]{64}$/.test(receiptHash) ||
      receiptHash !== text(consumerReceipt.receiptHash) ||
      integer(receipt.fixtureId) !== fixtureId ||
      receipt.outcome !== "WIN" ||
      canonicalBody.proofStatus !== "VERIFIED" ||
      canonicalBody.outcome !== "WIN" ||
      text(canonicalFixture.id) !== String(fixtureId) ||
      canonicalPredicate.type !== "match_winner" ||
      canonicalPredicate.selection !== expectedPredicateSelection ||
      oracle.predicateResult !== true ||
      oracle.verificationMode !== verificationMode ||
      execution.transactionSubmitted !== false ||
      sequence === null ||
      sequence < 1 ||
      integer(canonicalBody.seq) !== sequence ||
      integer(statValues["1"]) !== integer(score.participant1Goals) ||
      integer(statValues["2"]) !== integer(score.participant2Goals)
    ) {
      return false;
    }

    return (await hashCanonicalReceipt(canonicalBody)) === receiptHash;
  } catch {
    return false;
  }
}

export function normalizeFanVerification(
  payload: unknown,
  evidenceUrl: string,
  productUrl: string,
  integrityVerified = false,
): FanVerification | null {
  const body = record(payload);
  const fixture = record(body.fixture);
  const score = record(body.score);
  const proof = record(body.proof);
  const onChain = record(body.onChain);
  const receipt = record(body.receipt);
  const consumer = record(body.consumer);
  const fixtureId = integer(fixture.fixtureId);
  const participant1 = text(fixture.participant1);
  const participant2 = text(fixture.participant2);
  if (!fixtureId || !participant1 || !participant2) return null;

  const state = text(body.state) ?? "UNAVAILABLE";
  const outcomeValue = text(body.outcome);
  const outcome =
    outcomeValue === "WIN" ||
    outcomeValue === "LOSE" ||
    outcomeValue === "PUSH" ||
    outcomeValue === "VOID"
      ? outcomeValue
      : null;
  const proofStatus = text(proof.status) ?? "UNAVAILABLE";
  const receiptHash = text(receipt.receiptHash);
  const verificationModeValue = text(onChain.verificationMode);
  const verificationMode =
    verificationModeValue === "live-view" || verificationModeValue === "verified-snapshot"
      ? verificationModeValue
      : "unverified";
  const consumerReady = consumer.ready === true;
  const winner = finalWinner(body);
  const verified =
    state === "RESOLVED" &&
    outcome === "WIN" &&
    Boolean(winner && receiptHash) &&
    proofStatus === "VERIFIED_ONCHAIN" &&
    onChain.verified === true &&
    consumerReady &&
    integrityVerified;
  const waitingStates = new Set(["OPEN", "AWAITING_FINAL", "AWAITING_PROOF"]);
  const status: FanVerificationStatus = verified
    ? "verified"
    : waitingStates.has(state)
      ? "waiting"
      : "unverified";

  const participant1Goals = integer(score.participant1Goals);
  const participant2Goals = integer(score.participant2Goals);
  const scoreLabel =
    participant1Goals !== null && participant2Goals !== null
      ? `${participant1Goals} — ${participant2Goals}`
      : null;
  const winnerLabel =
    winner === "participant1"
      ? participant1
      : winner === "participant2"
        ? participant2
        : winner === "draw"
          ? "Draw"
          : null;
  const message = verified
    ? winner === "draw"
      ? `The match finished level at ${scoreLabel}. The final score and draw predicate have a verified TxLINE proof.`
      : `${winnerLabel} won ${scoreLabel}. The final score and winner predicate have a verified TxLINE proof.`
    : state === "OPEN"
      ? "The match is still open. FanPulse will not issue a result badge before finality and proof are both available."
      : state === "AWAITING_FINAL"
        ? "A score exists, but TxLINE has not emitted a finalisation record yet."
        : state === "AWAITING_PROOF"
          ? "The result is final, but the proof required for a verified receipt is not available yet."
          : state === "VOID"
            ? "The fixture was voided, so FanPulse will not display a winner badge."
            : "A proof-backed final-result receipt is not available right now.";

  return {
    fixtureId,
    fixtureLabel: `${participant1} vs ${participant2}`,
    winner,
    winnerLabel,
    score: scoreLabel,
    state,
    outcome,
    status,
    message,
    receiptHash,
    scoreSequence: integer(receipt.scoreSequence),
    proofStatus,
    verificationMode,
    consumerReady,
    consumerStatus: text(consumer.status),
    issuedAt: text(receipt.issuedAt),
    evidenceUrl,
    productUrl,
  };
}
