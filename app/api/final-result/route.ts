import {
  finalWinner,
  normalizeFanVerification,
  verifySettleTraceReceiptIntegrity,
} from "../../lib/fan-verification.ts";

const DEFAULT_SETTLETRACE_ORIGIN =
  "https://settletrace.oddpulse-txline-2026.workers.dev";
const COMPLETED_EXAMPLE_FIXTURE_ID = 18_179_550;

const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers });

function settleTraceOrigin() {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Partial<Record<"SETTLETRACE_ORIGIN", string>> };
  };
  const configured = runtime.process?.env?.SETTLETRACE_ORIGIN || DEFAULT_SETTLETRACE_ORIGIN;
  const url = new URL(configured);
  if (url.protocol !== "https:") throw new TypeError("SettleTrace origin must use HTTPS.");
  return url.origin;
}

async function loadResolution(
  origin: string,
  fixtureId: number,
  selection: "participant1" | "draw" | "participant2",
) {
  const evidenceUrl = new URL("/api/settletrace", origin);
  evidenceUrl.searchParams.set("fixtureId", String(fixtureId));
  evidenceUrl.searchParams.set("kind", "match_winner");
  evidenceUrl.searchParams.set("selection", selection);
  const response = await fetch(evidenceUrl, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error("SETTLETRACE_HTTP_ERROR");
  return { body: (await response.json()) as unknown, evidenceUrl };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const example = url.searchParams.get("example") === "completed";
  const fixtureValue = example
    ? String(COMPLETED_EXAMPLE_FIXTURE_ID)
    : url.searchParams.get("fixtureId") || "";
  if (!/^\d{1,12}$/.test(fixtureValue)) {
    return json(
      { code: "INVALID_FIXTURE", message: "A valid fixture ID is required." },
      400,
    );
  }
  const fixtureId = Number(fixtureValue);
  if (!Number.isSafeInteger(fixtureId) || fixtureId < 1) {
    return json({ code: "INVALID_FIXTURE", message: "Fixture ID is invalid." }, 400);
  }

  try {
    const origin = settleTraceOrigin();
    let resolution = await loadResolution(origin, fixtureId, "participant1");
    const winner = finalWinner(resolution.body);
    if (winner && winner !== "participant1") {
      resolution = await loadResolution(origin, fixtureId, winner);
    }

    const integrityVerified = await verifySettleTraceReceiptIntegrity(resolution.body);
    const verification = normalizeFanVerification(
      resolution.body,
      resolution.evidenceUrl.toString(),
      `${origin}/`,
      integrityVerified,
    );
    if (!verification) {
      return json(
        {
          code: "RESULT_RESPONSE_INVALID",
          message: "The evidence source returned an incomplete final result.",
        },
        502,
      );
    }
    return json({ mode: example ? "completed-example" : "selected-fixture", verification });
  } catch {
    return json(
      {
        code: "RESULT_SOURCE_UNAVAILABLE",
        message: "The final-result evidence source is temporarily unavailable.",
      },
      502,
    );
  }
}
