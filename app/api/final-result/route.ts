import { env as workerEnv } from "cloudflare:workers";
import {
  FinalResultSourceError,
  parseFinalResultRequest,
  resolveFinalResult,
  type SettleTraceService,
} from "../../lib/final-result-service.ts";

const headers = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers });

function settleTraceService(): SettleTraceService {
  const service = (workerEnv as unknown as { SETTLETRACE?: SettleTraceService })
    .SETTLETRACE;
  if (!service || typeof service.fetch !== "function") {
    throw new FinalResultSourceError("SERVICE_BINDING");
  }
  return service;
}

export async function GET(request: Request) {
  const input = parseFinalResultRequest(new URL(request.url));
  if (!input) {
    return json(
      { code: "INVALID_FIXTURE", message: "A valid fixture ID is required." },
      400,
    );
  }

  try {
    return json(await resolveFinalResult(input, settleTraceService()));
  } catch (error) {
    const stage =
      error instanceof FinalResultSourceError ? error.stage : "SUMMARY";
    return json(
      {
        code: `RESULT_${stage}_FAILED`,
        message: "The final-result evidence source is temporarily unavailable.",
      },
      502,
    );
  }
}
