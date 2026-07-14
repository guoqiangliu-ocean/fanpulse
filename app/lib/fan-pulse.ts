export type TxLineFixture = {
  fixtureId: number;
  participant1: string;
  participant2: string;
  participant1IsHome: boolean;
  home: string;
  away: string;
  startTime: string | number | null;
  competition: string;
  gameState: string | number;
};

export type TxLineOutcome = {
  name: string;
  rawPrice: number | null;
  probability: number | null;
};

export type TxLineMarket = {
  fixtureId: number;
  timestamp: number | null;
  provider: string;
  market: string;
  parameters: string;
  period: string;
  inRunning: boolean;
  gameState: string | number;
  outcomes: TxLineOutcome[];
};

export type TxLineScoreEvent = {
  fixtureId: number;
  timestamp: number | null;
  sequence: number | null;
  action: string;
  confirmed: boolean;
  statusSoccerId: number | null;
  clockSeconds: number | null;
  score: {
    participant1Goals: number | null;
    participant2Goals: number | null;
    participant1YellowCards: number | null;
    participant2YellowCards: number | null;
    participant1RedCards: number | null;
    participant2RedCards: number | null;
    participant1Corners: number | null;
    participant2Corners: number | null;
  };
  moment: {
    action: string;
    participant: number | null;
    minutes: number | null;
    outcome: string;
    type: string;
    goal: boolean;
    penalty: boolean;
    color: string;
    freeKickType: string;
  };
};

export type FanOutcome = {
  key: string;
  label: string;
  probability: number;
};

export type FanMarketView = {
  marketKey: string;
  marketLabel: string;
  marketDetail: string;
  sourceAt: number | null;
  providerCount: number;
  providerLabel: string;
  rawOutcomeCount: number;
  inRunning: boolean;
  outcomes: FanOutcome[];
};

export type FanInsight = {
  state: "waiting" | "raw-only" | "probability";
  headline: string;
  explanation: string;
  change: string;
  trust: string;
  leader: FanOutcome | null;
  delta: number | null;
};

const normalized = (value: unknown) =>
  String(value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ");

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

export function outcomeLabel(name: string, fixture: TxLineFixture) {
  const key = normalized(name).toLowerCase();
  if (key === "part1" || key === "participant1") return fixture.participant1;
  if (key === "part2" || key === "participant2") return fixture.participant2;
  if (key === "draw") return "Draw";
  if (key === "over") return "Over";
  if (key === "under") return "Under";
  return normalized(name).replaceAll("_", " ");
}

function marketIdentity(market: TxLineMarket) {
  return [
    normalized(market.market).toLowerCase(),
    normalized(market.period).toLowerCase(),
    normalized(market.parameters),
    String(Boolean(market.inRunning)),
    normalized(market.gameState).toLowerCase(),
  ].join("|");
}

function marketScore(markets: TxLineMarket[]) {
  const first = markets[0];
  const name = normalized(first.market).toUpperCase();
  const period = normalized(first.period).toLowerCase();
  const hasCompleteProbabilityVector = first.outcomes.every((outcome) => {
    const probability = finite(outcome.probability);
    return probability !== null && probability >= 0.002 && probability <= 0.998;
  });
  let score = 0;
  if (name === "1X2_PARTICIPANT_RESULT") score += 120;
  if (period === "match") score += 38;
  if (!normalized(first.parameters)) score += 12;
  if (hasCompleteProbabilityVector) score += 35;
  if (first.outcomes.length === 3) score += 16;
  score += new Set(markets.map((market) => normalized(market.provider))).size;
  return score;
}

function marketCopy(market: TxLineMarket) {
  const name = normalized(market.market).toUpperCase();
  const period = normalized(market.period).toLowerCase();
  const parameters = normalized(market.parameters);
  const periodLabel =
    period === "match"
      ? "Full match"
      : period === "half=1"
        ? "First half"
        : period === "half=2"
          ? "Second half"
          : period || "Unspecified period";

  if (name === "1X2_PARTICIPANT_RESULT") {
    return {
      label: period === "match" ? "Full-time result" : `${periodLabel} result`,
      detail: `${periodLabel} · ${market.inRunning ? "In play" : "Snapshot"}`,
    };
  }
  if (name === "OVERUNDER_PARTICIPANT_GOALS") {
    return {
      label: "Goals line",
      detail: `${periodLabel}${parameters ? ` · ${parameters}` : ""}`,
    };
  }
  if (name === "ASIANHANDICAP_PARTICIPANT_GOALS") {
    return {
      label: "Goal handicap",
      detail: `${periodLabel}${parameters ? ` · ${parameters}` : ""}`,
    };
  }
  return {
    label: normalized(market.market).replaceAll("_", " "),
    detail: `${periodLabel}${parameters ? ` · ${parameters}` : ""}`,
  };
}

export function buildFanMarketView(
  fixture: TxLineFixture,
  markets: TxLineMarket[],
): FanMarketView | null {
  const groups = new Map<string, TxLineMarket[]>();
  for (const market of markets) {
    if (market.fixtureId !== fixture.fixtureId || !market.outcomes?.length) continue;
    const key = marketIdentity(market);
    groups.set(key, [...(groups.get(key) ?? []), market]);
  }
  const selected = [...groups.entries()].sort(
    ([leftKey, left], [rightKey, right]) =>
      marketScore(right) - marketScore(left) || leftKey.localeCompare(rightKey),
  )[0];
  if (!selected) return null;

  const [marketKey, group] = selected;
  const first = group[0];
  const order = first.outcomes.map((outcome) => normalized(outcome.name).toLowerCase());
  const values = new Map<string, number[]>();
  let rawOutcomeCount = 0;
  for (const market of group) {
    for (const outcome of market.outcomes) {
      const key = normalized(outcome.name).toLowerCase();
      const probability = finite(outcome.probability);
      if (finite(outcome.rawPrice) !== null) rawOutcomeCount += 1;
      if (probability === null || probability < 0.002 || probability > 0.998) {
        continue;
      }
      values.set(key, [...(values.get(key) ?? []), probability]);
    }
  }
  const outcomes = order
    .filter((key, index) => order.indexOf(key) === index)
    .filter((key) => values.has(key))
    .map((key) => ({
      key,
      label: outcomeLabel(key, fixture),
      probability: median(values.get(key)!),
    }));
  const providers = [...new Set(group.map((market) => normalized(market.provider)))].filter(
    Boolean,
  );
  const timestamps = group
    .map((market) => finite(market.timestamp))
    .filter((value): value is number => value !== null);
  const copy = marketCopy(first);
  return {
    marketKey,
    marketLabel: copy.label,
    marketDetail: copy.detail,
    sourceAt: timestamps.length ? Math.max(...timestamps) : null,
    providerCount: providers.length,
    providerLabel:
      providers.length === 1 ? providers[0] : `${providers.length} matched providers`,
    rawOutcomeCount,
    inRunning: first.inRunning,
    outcomes,
  };
}

export function buildFanInsight(
  fixture: TxLineFixture,
  current: FanMarketView | null,
  previous: FanMarketView | null,
): FanInsight {
  if (!current) {
    return {
      state: "waiting",
      headline: "The fixture is here. The market pulse is still on its way.",
      explanation:
        "TxLINE has authenticated the fixture, but no usable market snapshot is available right now.",
      change: "FanPulse will check again while this tab stays visible.",
      trust: "No probability has been inferred or filled in.",
      leader: null,
      delta: null,
    };
  }
  if (!current.outcomes.length) {
    return {
      state: "raw-only",
      headline: "Prices are present, but the probability story is incomplete.",
      explanation:
        "TxLINE supplied raw values without a complete probability vector. FanPulse keeps them out of the fan pick instead of guessing their scale.",
      change: "Waiting for a probability-bearing snapshot.",
      trust: `${current.providerLabel} · ${current.marketDetail}`,
      leader: null,
      delta: null,
    };
  }

  const leader = [...current.outcomes].sort(
    (left, right) =>
      right.probability - left.probability || left.label.localeCompare(right.label),
  )[0];
  const previousLeader =
    previous?.marketKey === current.marketKey
      ? previous.outcomes.find((outcome) => outcome.key === leader.key)
      : null;
  const delta = previousLeader ? leader.probability - previousLeader.probability : null;
  const changedSource =
    previous?.sourceAt !== null &&
    current.sourceAt !== null &&
    previous?.sourceAt !== current.sourceAt;
  const change =
    delta === null
      ? "Baseline saved. The next exact-series update will show the change."
      : !changedSource
        ? "No new source timestamp yet. The current pulse is unchanged."
        : Math.abs(delta) < 0.005
          ? "The latest exact-series update stayed within 0.5 percentage points."
          : `${leader.label} moved ${delta > 0 ? "up" : "down"} ${Math.abs(
              delta * 100,
            ).toFixed(1)} percentage points since the previous source update.`;

  return {
    state: "probability",
    headline: `${leader.label} leads the ${current.marketLabel.toLowerCase()} pulse`,
    explanation: `${(leader.probability * 100).toFixed(
      1,
    )}% in the latest authenticated snapshot for ${fixture.participant1} vs ${fixture.participant2}.`,
    change,
    trust:
      current.providerCount > 1
        ? `${current.providerCount} matched providers contribute to this snapshot.`
        : "One provider is currently available. This is a snapshot, not broad market consensus.",
    leader,
    delta,
  };
}

const SOCCER_PHASES: Record<number, string> = {
  1: "Not started",
  2: "First half",
  3: "Halftime",
  4: "Second half",
  5: "Finished",
  6: "Waiting for extra time",
  7: "Extra time · first half",
  8: "Extra-time halftime",
  9: "Extra time · second half",
  10: "Finished after extra time",
  11: "Waiting for penalties",
  12: "Penalty shootout",
  13: "Finished after penalties",
  14: "Interrupted",
  15: "Abandoned",
  16: "Cancelled",
  17: "Coverage cancelled",
  18: "Coverage suspended",
  19: "Postponed",
};

export function buildScoreStory(
  fixture: TxLineFixture,
  events: TxLineScoreEvent[],
) {
  const latest = [...events].sort(
    (left, right) =>
      (right.timestamp ?? -1) - (left.timestamp ?? -1) ||
      (right.sequence ?? -1) - (left.sequence ?? -1),
  )[0];
  if (!latest) {
    return {
      phase: fixture.gameState === 6 ? "Cancelled" : "No score event yet",
      score: "—",
      moment: "The score feed has not published a current match moment.",
      sourceAt: null as number | null,
    };
  }
  const p1 = latest.score.participant1Goals;
  const p2 = latest.score.participant2Goals;
  const score = p1 !== null && p2 !== null ? `${p1} — ${p2}` : "—";
  const action = normalized(latest.moment.action || latest.action)
    .replaceAll("_", " ")
    .toLowerCase();
  const participant =
    latest.moment.participant === 1
      ? fixture.participant1
      : latest.moment.participant === 2
        ? fixture.participant2
        : "Match";
  const minute =
    latest.moment.minutes !== null ? ` · ${latest.moment.minutes}′` : "";
  return {
    phase: latest.statusSoccerId
      ? SOCCER_PHASES[latest.statusSoccerId] ?? "Score update"
      : "Score update",
    score,
    moment: action
      ? `${participant}: ${action}${minute}${latest.confirmed ? " · confirmed" : ""}`
      : "A score snapshot is available, with no public action label.",
    sourceAt: latest.timestamp,
  };
}

export function formatSourceTime(value: number | null) {
  if (value === null) return "Source time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Source time unavailable";
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function fixtureKickoff(value: string | number | null) {
  if (value === null) return "Kick-off time unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Kick-off time unavailable";
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
