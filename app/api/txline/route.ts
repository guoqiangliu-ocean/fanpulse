import { env as workerEnv } from "cloudflare:workers";
import { normalizeProbabilityVector } from "../../lib/txline-normalize";

type RuntimeKey =
  | "TXLINE_API_TOKEN"
  | "TXLINE_BASE_URL"
  | "TXLINE_NETWORK"
  | "TXLINE_SESSION_JWT";

type JsonObject = Record<string, unknown>;

const runtimeValue = (key: RuntimeKey) => {
  const binding = (workerEnv as unknown as Partial<Record<RuntimeKey, string>>)[
    key
  ];
  return binding || process.env[key];
};

const configured = () => Boolean(runtimeValue("TXLINE_API_TOKEN"));
const baseUrl = () =>
  (runtimeValue("TXLINE_BASE_URL") || "https://txline-dev.txodds.com").replace(
    /\/$/,
    "",
  );
const network = () =>
  runtimeValue("TXLINE_NETWORK") ||
  (baseUrl().includes("txline-dev") ? "devnet" : "mainnet");

let guestSession: { token: string; expiresAt: number } | null =
  runtimeValue("TXLINE_SESSION_JWT")
    ? {
        token: runtimeValue("TXLINE_SESSION_JWT")!,
        expiresAt: Date.now() + 60_000,
      }
    : null;
let guestRefresh: Promise<string> | null = null;
const responseCache = new Map<
  string,
  { expiresAt: number; value: unknown }
>();
const inFlight = new Map<string, Promise<unknown>>();

const jsonHeaders = { "Cache-Control": "no-store" };

const asObject = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

const read = (source: unknown, ...keys: string[]) => {
  const object = asObject(source);
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return undefined;
};

const textValue = (value: unknown, fallback = "") => {
  if (typeof value !== "string") return fallback;
  return value.normalize("NFC").trim().replace(/\s+/g, " ").slice(0, 180);
};

const finiteNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const safeBoolean = (value: unknown) => value === true;

async function getGuestJwt(forceRefresh = false) {
  if (!forceRefresh && guestSession && guestSession.expiresAt > Date.now()) {
    return guestSession.token;
  }
  if (!guestRefresh) {
    guestRefresh = fetch(`${baseUrl()}/auth/guest/start`, {
      method: "POST",
      headers: { Accept: "application/json" },
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("guest_auth_failed");
        const body = (await response.json()) as { token?: string };
        if (!body.token) throw new Error("guest_auth_failed");
        guestSession = {
          token: body.token,
          expiresAt: Date.now() + 8 * 60_000,
        };
        return body.token;
      })
      .finally(() => {
        guestRefresh = null;
      });
  }
  return guestRefresh;
}

const upstreamHeaders = (jwt: string) => ({
  Authorization: `Bearer ${jwt}`,
  "X-Api-Token": runtimeValue("TXLINE_API_TOKEN") || "",
  Accept: "application/json",
});

async function fetchUpstream(path: string) {
  let jwt = await getGuestJwt();
  let response = await fetch(`${baseUrl()}${path}`, {
    headers: upstreamHeaders(jwt),
    cache: "no-store",
  });
  if (response.status === 401) {
    jwt = await getGuestJwt(true);
    response = await fetch(`${baseUrl()}${path}`, {
      headers: upstreamHeaders(jwt),
      cache: "no-store",
    });
  }
  if (!response.ok) throw new Error("upstream_request_failed");
  return response.json();
}

async function cachedUpstream(path: string, ttlMs: number) {
  const current = responseCache.get(path);
  if (current && current.expiresAt > Date.now()) return current.value;
  const pending = inFlight.get(path);
  if (pending) return pending;
  const request = fetchUpstream(path)
    .then((value) => {
      responseCache.set(path, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => inFlight.delete(path));
  inFlight.set(path, request);
  return request;
}

function normalizeFixture(raw: unknown) {
  const fixtureId = finiteNumber(read(raw, "FixtureId", "fixtureId"));
  const participant1 = textValue(
    read(raw, "Participant1", "participant1"),
    "Participant 1",
  );
  const participant2 = textValue(
    read(raw, "Participant2", "participant2"),
    "Participant 2",
  );
  const participant1IsHome =
    read(raw, "Participant1IsHome", "participant1IsHome") !== false;
  return {
    fixtureId,
    participant1,
    participant2,
    participant1IsHome,
    home: participant1IsHome ? participant1 : participant2,
    away: participant1IsHome ? participant2 : participant1,
    startTime: read(raw, "StartTime", "startTime") ?? null,
    competition: textValue(
      read(raw, "Competition", "competition"),
      "Unknown competition",
    ),
    gameState: read(raw, "GameState", "gameState") ?? "unknown",
  };
}

function normalizeMarket(raw: unknown) {
  const names = read(raw, "PriceNames", "priceNames");
  const prices = read(raw, "Prices", "prices");
  const percentages = read(raw, "Pct", "pct");
  const safeNames = Array.isArray(names) ? names : [];
  const safePrices = Array.isArray(prices) ? prices : [];
  const safePercentages = Array.isArray(percentages) ? percentages : [];
  const probabilities = normalizeProbabilityVector(
    safeNames,
    safePercentages,
  );
  return {
    fixtureId: finiteNumber(read(raw, "FixtureId", "fixtureId")),
    timestamp: finiteNumber(read(raw, "Ts", "ts")),
    provider: textValue(
      read(raw, "Bookmaker", "bookmaker"),
      "TxLINE StablePrice",
    ),
    market: textValue(read(raw, "SuperOddsType", "superOddsType"), "unknown"),
    parameters: textValue(read(raw, "MarketParameters", "marketParameters")),
    period: textValue(read(raw, "MarketPeriod", "marketPeriod"), "match"),
    inRunning: safeBoolean(read(raw, "InRunning", "inRunning")),
    gameState: read(raw, "GameState", "gameState") ?? "unknown",
    outcomes: safeNames.map((name, index) => ({
      name: textValue(name, `Outcome ${index + 1}`),
      rawPrice: finiteNumber(safePrices[index]),
      probability: probabilities[index],
    })),
  };
}

function soccerStat(source: unknown, participant: "Participant1" | "Participant2", key: string) {
  const score = read(source, "scoreSoccer", "ScoreSoccer");
  const participantBlock = read(
    score,
    participant,
    participant.toLowerCase(),
  );
  const total = read(participantBlock, "Total", "total");
  return finiteNumber(read(total, key, key.toLowerCase()));
}

function normalizeScoreEvent(raw: unknown) {
  const data = read(raw, "dataSoccer", "DataSoccer");
  const clock = read(raw, "clock", "Clock");
  return {
    fixtureId: finiteNumber(read(raw, "fixtureId", "FixtureId")),
    timestamp: finiteNumber(read(raw, "ts", "Ts")),
    sequence: finiteNumber(read(raw, "seq", "Seq")),
    action: textValue(read(raw, "action", "Action")),
    confirmed: safeBoolean(read(raw, "confirmed", "Confirmed")),
    statusSoccerId: finiteNumber(read(raw, "statusSoccerId", "StatusSoccerId")),
    clockSeconds: finiteNumber(read(clock, "seconds", "Seconds")),
    score: {
      participant1Goals: soccerStat(raw, "Participant1", "Goals"),
      participant2Goals: soccerStat(raw, "Participant2", "Goals"),
      participant1YellowCards: soccerStat(raw, "Participant1", "YellowCards"),
      participant2YellowCards: soccerStat(raw, "Participant2", "YellowCards"),
      participant1RedCards: soccerStat(raw, "Participant1", "RedCards"),
      participant2RedCards: soccerStat(raw, "Participant2", "RedCards"),
      participant1Corners: soccerStat(raw, "Participant1", "Corners"),
      participant2Corners: soccerStat(raw, "Participant2", "Corners"),
    },
    moment: {
      action: textValue(read(data, "Action", "action")),
      participant: finiteNumber(read(data, "Participant", "participant")),
      minutes: finiteNumber(read(data, "Minutes", "minutes")),
      outcome: textValue(read(data, "Outcome", "outcome")),
      type: textValue(read(data, "Type", "type")),
      goal: safeBoolean(read(data, "Goal", "goal")),
      penalty: safeBoolean(read(data, "Penalty", "penalty")),
      color: textValue(read(data, "Color", "color")),
      freeKickType: textValue(read(data, "FreeKickType", "freeKickType")),
    },
  };
}

async function worldCupFixtures() {
  const raw = await cachedUpstream("/api/fixtures/snapshot", 60_000);
  const rows = Array.isArray(raw) ? raw : [];
  return rows
    .map(normalizeFixture)
    .filter(
      (fixture) =>
        Number.isSafeInteger(fixture.fixtureId) &&
        Number(fixture.fixtureId) > 0 &&
        fixture.competition.toLowerCase().includes("world cup"),
    );
}

export async function GET(request: Request) {
  if (!configured()) {
    return Response.json(
      {
        configured: false,
        mode: "unavailable",
        network: network(),
        message: "TxLINE access is not configured for this deployment.",
      },
      { status: 503, headers: jsonHeaders },
    );
  }

  const url = new URL(request.url);
  const fixtureParam = url.searchParams.get("fixtureId");
  try {
    const fixtures = await worldCupFixtures();
    if (!fixtureParam) {
      return Response.json(
        {
          configured: true,
          mode: "authenticated-snapshot",
          network: network(),
          fetchedAt: Date.now(),
          fixtures,
        },
        { headers: jsonHeaders },
      );
    }

    if (!/^\d+$/.test(fixtureParam)) {
      return Response.json(
        { code: "INVALID_FIXTURE", message: "Fixture ID is invalid." },
        { status: 400, headers: jsonHeaders },
      );
    }
    const fixtureId = Number(fixtureParam);
    const fixture = fixtures.find((item) => item.fixtureId === fixtureId);
    if (!Number.isSafeInteger(fixtureId) || fixtureId <= 0 || !fixture) {
      return Response.json(
        { code: "FIXTURE_NOT_AVAILABLE", message: "Fixture is not available." },
        { status: 404, headers: jsonHeaders },
      );
    }

    const [oddsResult, scoresResult] = await Promise.allSettled([
      cachedUpstream(`/api/odds/snapshot/${fixtureId}`, 12_000),
      cachedUpstream(`/api/scores/snapshot/${fixtureId}`, 12_000),
    ]);
    if (oddsResult.status === "rejected" && scoresResult.status === "rejected") {
      throw new Error("fixture_streams_unavailable");
    }
    const odds =
      oddsResult.status === "fulfilled" && Array.isArray(oddsResult.value)
        ? oddsResult.value
        : [];
    const scores =
      scoresResult.status === "fulfilled" && Array.isArray(scoresResult.value)
        ? scoresResult.value
        : [];

    return Response.json(
      {
        configured: true,
        mode: "authenticated-snapshot",
        network: network(),
        fetchedAt: Date.now(),
        fixture,
        markets: odds
          .map(normalizeMarket)
          .filter((market) => market.fixtureId === fixtureId),
        scoreStatus: scoresResult.status === "fulfilled" ? "available" : "unavailable",
        scoreEvents: scores
          .map(normalizeScoreEvent)
          .filter((event) => event.fixtureId === fixtureId)
          .sort(
            (left, right) =>
              (left.timestamp ?? -1) - (right.timestamp ?? -1) ||
              (left.sequence ?? -1) - (right.sequence ?? -1),
          )
          .slice(-24),
      },
      { headers: jsonHeaders },
    );
  } catch {
    return Response.json(
      {
        configured: true,
        mode: "unavailable",
        network: network(),
        code: "TXLINE_UNAVAILABLE",
        message: "The authenticated TxLINE snapshot is temporarily unavailable.",
      },
      { status: 502, headers: jsonHeaders },
    );
  }
}
