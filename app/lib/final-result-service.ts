import {
  finalWinner,
  normalizeFanVerification,
  verifySettleTraceReceiptIntegrity,
  type FanVerification,
  type MatchWinner,
} from "./fan-verification.ts";

const COMPLETED_EXAMPLE_FIXTURE_ID = 18_179_550;
const SETTLETRACE_SERVICE_ORIGIN = "https://settletrace.service";
const SETTLETRACE_PUBLIC_ORIGIN =
  "https://settletrace.oddpulse-txline-2026.workers.dev";

export type SettleTraceService = {
  fetch(request: Request): Promise<Response>;
};

export type FinalResultRequest = {
  fixtureId: number;
  example: boolean;
};

export type FinalResultResponse = {
  mode: "completed-example" | "selected-fixture";
  verification: FanVerification;
};

export type FinalResultFailureStage =
  | "SERVICE_BINDING"
  | "INITIAL_RESOLUTION"
  | "WINNER_RESOLUTION"
  | "RECEIPT_INTEGRITY"
  | "SUMMARY";

export class FinalResultSourceError extends Error {
  readonly stage: FinalResultFailureStage;

  constructor(stage: FinalResultFailureStage) {
    super("Final-result source is unavailable.");
    this.stage = stage;
  }
}

export function parseFinalResultRequest(url: URL): FinalResultRequest | null {
  const example = url.searchParams.get("example") === "completed";
  const fixtureValue = example
    ? String(COMPLETED_EXAMPLE_FIXTURE_ID)
    : url.searchParams.get("fixtureId") || "";
  if (!/^\d{1,12}$/.test(fixtureValue)) return null;
  const fixtureId = Number(fixtureValue);
  if (!Number.isSafeInteger(fixtureId) || fixtureId < 1) return null;
  return { fixtureId, example };
}

async function loadResolution(
  service: SettleTraceService,
  fixtureId: number,
  selection: MatchWinner,
  stage: "INITIAL_RESOLUTION" | "WINNER_RESOLUTION",
) {
  const requestUrl = new URL("/api/settletrace", SETTLETRACE_SERVICE_ORIGIN);
  requestUrl.searchParams.set("fixtureId", String(fixtureId));
  requestUrl.searchParams.set("kind", "match_winner");
  requestUrl.searchParams.set("selection", selection);
  const evidenceUrl = new URL("/api/settletrace", SETTLETRACE_PUBLIC_ORIGIN);
  evidenceUrl.search = requestUrl.search;

  try {
    const response = await service.fetch(
      new Request(requestUrl, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(12_000),
      }),
    );
    if (!response.ok || response.status >= 300) {
      throw new Error("SETTLETRACE_HTTP_ERROR");
    }
    return { body: (await response.json()) as unknown, evidenceUrl };
  } catch {
    throw new FinalResultSourceError(stage);
  }
}

export async function resolveFinalResult(
  request: FinalResultRequest,
  service: SettleTraceService,
): Promise<FinalResultResponse> {
  let resolution = await loadResolution(
    service,
    request.fixtureId,
    "participant1",
    "INITIAL_RESOLUTION",
  );
  const winner = finalWinner(resolution.body);
  if (winner && winner !== "participant1") {
    resolution = await loadResolution(
      service,
      request.fixtureId,
      winner,
      "WINNER_RESOLUTION",
    );
  }

  let integrityVerified: boolean;
  try {
    integrityVerified = await verifySettleTraceReceiptIntegrity(resolution.body);
  } catch {
    throw new FinalResultSourceError("RECEIPT_INTEGRITY");
  }

  let verification: FanVerification | null;
  try {
    verification = normalizeFanVerification(
      resolution.body,
      resolution.evidenceUrl.toString(),
      `${SETTLETRACE_PUBLIC_ORIGIN}/`,
      integrityVerified,
    );
  } catch {
    throw new FinalResultSourceError("SUMMARY");
  }
  if (!verification) throw new FinalResultSourceError("SUMMARY");

  return {
    mode: request.example ? "completed-example" : "selected-fixture",
    verification,
  };
}
