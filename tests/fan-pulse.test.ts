import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFanInsight,
  buildFanMarketView,
  buildScoreStory,
  outcomeLabel,
  type TxLineFixture,
  type TxLineMarket,
} from "../app/lib/fan-pulse.ts";
import { normalizeProbabilityVector } from "../app/lib/txline-normalize.ts";

const fixture: TxLineFixture = {
  fixtureId: 42,
  participant1: "Alpha",
  participant2: "Beta",
  participant1IsHome: false,
  home: "Beta",
  away: "Alpha",
  startTime: Date.UTC(2026, 6, 18, 16),
  competition: "World Cup",
  gameState: 1,
};

function market(
  overrides: Partial<TxLineMarket> = {},
): TxLineMarket {
  return {
    fixtureId: 42,
    timestamp: 1_000,
    provider: "Provider A",
    market: "1X2_PARTICIPANT_RESULT",
    parameters: "",
    period: "match",
    inRunning: false,
    gameState: 1,
    outcomes: [
      { name: "part1", rawPrice: 2500, probability: 0.4 },
      { name: "draw", rawPrice: 3333, probability: 0.3 },
      { name: "part2", rawPrice: 3333, probability: 0.3 },
    ],
    ...overrides,
  };
}

test("normalizes complete fraction and percent probability vectors", () => {
  assert.deepEqual(
    normalizeProbabilityVector(["a", "b", "c"], [0.48, 0.3, 0.22]),
    [0.48, 0.3, 0.22],
  );
  assert.deepEqual(
    normalizeProbabilityVector(["a", "b", "c"], ["48", "30", "22"]),
    [0.48, 0.3, 0.22],
  );
});

test("rejects mixed scales and incomplete probability vectors", () => {
  assert.deepEqual(
    normalizeProbabilityVector(["a", "b", "c"], [0.48, 30, 0.22]),
    [null, null, null],
  );
  assert.deepEqual(
    normalizeProbabilityVector(["a", "b", "c"], [48, 30]),
    [null, null, null],
  );
});

test("maps participant outcomes without guessing from home and away", () => {
  assert.equal(outcomeLabel("part1", fixture), "Alpha");
  assert.equal(outcomeLabel("part2", fixture), "Beta");
});

test("prefers a full-match 1X2 market and aggregates matched providers", () => {
  const view = buildFanMarketView(fixture, [
    market({ period: "half=1", timestamp: 900 }),
    market(),
    market({
      provider: "Provider B",
      outcomes: [
        { name: "part1", rawPrice: 2400, probability: 0.42 },
        { name: "draw", rawPrice: 3400, probability: 0.29 },
        { name: "part2", rawPrice: 3400, probability: 0.29 },
      ],
    }),
  ]);
  assert.ok(view);
  assert.equal(view.marketLabel, "Full-time result");
  assert.equal(view.providerCount, 2);
  assert.equal(view.outcomes[0].probability, 0.41000000000000003);
});

test("keeps raw-only markets out of the fan probability pick", () => {
  const view = buildFanMarketView(fixture, [
    market({
      outcomes: [
        { name: "part1", rawPrice: 2000, probability: null },
        { name: "draw", rawPrice: 3000, probability: null },
        { name: "part2", rawPrice: 4000, probability: null },
      ],
    }),
  ]);
  const insight = buildFanInsight(fixture, view, null);
  assert.equal(view?.outcomes.length, 0);
  assert.equal(insight.state, "raw-only");
  assert.match(insight.explanation, /instead of guessing/);
});

test("compares only an exact market identity", () => {
  const previous = buildFanMarketView(fixture, [market()]);
  const current = buildFanMarketView(fixture, [
    market({
      timestamp: 2_000,
      outcomes: [
        { name: "part1", rawPrice: 2100, probability: 0.48 },
        { name: "draw", rawPrice: 3600, probability: 0.28 },
        { name: "part2", rawPrice: 4200, probability: 0.24 },
      ],
    }),
  ]);
  const insight = buildFanInsight(fixture, current, previous);
  assert.equal(insight.delta, 0.07999999999999996);
  assert.match(insight.change, /8\.0 percentage points/);

  const differentLine = buildFanMarketView(fixture, [
    market({ parameters: "line=1", timestamp: 3_000 }),
  ]);
  assert.equal(buildFanInsight(fixture, differentLine, current).delta, null);
});

test("builds a score story from safe soccer totals", () => {
  const story = buildScoreStory(fixture, [
    {
      fixtureId: 42,
      timestamp: 3_000,
      sequence: 7,
      action: "goal",
      confirmed: true,
      statusSoccerId: 2,
      clockSeconds: 1_200,
      score: {
        participant1Goals: 1,
        participant2Goals: 0,
        participant1YellowCards: 0,
        participant2YellowCards: 0,
        participant1RedCards: 0,
        participant2RedCards: 0,
        participant1Corners: 1,
        participant2Corners: 2,
      },
      moment: {
        action: "goal",
        participant: 1,
        minutes: 20,
        outcome: "",
        type: "",
        goal: true,
        penalty: false,
        color: "",
        freeKickType: "",
      },
    },
  ]);
  assert.equal(story.phase, "First half");
  assert.equal(story.score, "1 — 0");
  assert.match(story.moment, /Alpha: goal · 20′ · confirmed/);
});
