"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildFanInsight,
  buildFanMarketView,
  buildScoreStory,
  fixtureKickoff,
  formatSourceTime,
  type FanMarketView,
  type TxLineFixture,
  type TxLineMarket,
  type TxLineScoreEvent,
} from "./lib/fan-pulse";
import { type FanVerification } from "./lib/fan-verification";
import styles from "./fanpulse.module.css";

type LoadState = "loading" | "ready" | "empty" | "error";
type VerificationLoadState = "idle" | "loading" | "ready" | "error";

type VerificationPanelState = {
  state: VerificationLoadState;
  data: FanVerification | null;
  fixtureId?: number | null;
};

const IDLE_VERIFICATION_PANEL: VerificationPanelState = { state: "idle", data: null };

type PickRecord = {
  fixtureId: number;
  pick: string;
  pickLabel: string;
  leader: string;
  correct: boolean;
  sourceAt: number | null;
};

const PICK_STORAGE_KEY = "fanpulse-picks-v1";
const POLL_INTERVAL_MS = 15_000;

const REPLAY_FRAMES = [
  {
    label: "Kick-off",
    note: "The illustrative match starts balanced.",
    values: [37, 31, 32],
  },
  {
    label: "Big chance",
    note: "Blue City creates the first dangerous moment; the example pulse tilts.",
    values: [43, 30, 27],
  },
  {
    label: "Goal",
    note: "A fictional goal produces a clear repricing in this synthetic walkthrough.",
    values: [68, 20, 12],
  },
] as const;

const replayLabels = ["Blue City", "Draw", "Gold United"];

function safePickRecords(value: unknown): PickRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is PickRecord =>
      Boolean(item) &&
      typeof item === "object" &&
      Number.isSafeInteger((item as PickRecord).fixtureId) &&
      typeof (item as PickRecord).pick === "string" &&
      typeof (item as PickRecord).pickLabel === "string" &&
      typeof (item as PickRecord).leader === "string" &&
      typeof (item as PickRecord).correct === "boolean",
  );
}

function fixtureLabel(fixture: TxLineFixture) {
  return `${fixture.participant1} vs ${fixture.participant2}`;
}

function compactHash(value: string | null) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "Not issued";
}

async function requestVerification(path: string, signal: AbortSignal) {
  const response = await fetch(path, { signal, cache: "no-store" });
  const body = (await response.json()) as { verification?: FanVerification };
  if (!response.ok || !body.verification) throw new Error("result_proof_unavailable");
  return body.verification;
}

function ResultReceiptCard({
  eyebrow,
  panel,
  idleMessage,
  historical = false,
}: {
  eyebrow: string;
  panel: VerificationPanelState;
  idleMessage: string;
  historical?: boolean;
}) {
  const verification = panel.data;
  const badge =
    panel.state === "loading"
      ? "CHECKING"
      : panel.state === "error"
        ? "UNAVAILABLE"
        : verification?.status === "verified"
          ? "HASH VERIFIED"
          : verification?.status === "waiting"
            ? "WAITING"
            : "NOT VERIFIED";
  const title =
    panel.state === "loading"
      ? "Checking the final-result gate…"
      : panel.state === "error"
        ? "The proof service is temporarily unavailable"
        : verification?.status === "verified"
          ? `${verification.fixtureLabel}: final result verified`
          : verification?.status === "waiting"
            ? `${verification.fixtureLabel}: waiting for final proof`
            : verification
              ? `${verification.fixtureLabel}: no verified receipt`
              : "Final-result proof appears here";
  const statusClass = verification?.status ?? panel.state;

  return (
    <article className={`${styles.receiptCard} ${styles[`receipt_${statusClass}`] ?? ""}`}>
      <div className={styles.receiptTopline}>
        <span>{eyebrow}</span>
        <strong>{badge}</strong>
      </div>
      <h3>{title}</h3>
      <p className={styles.receiptLead}>
        {verification?.message ??
          (panel.state === "error"
            ? "Your FanPulse experience still works. No result is promoted without proof."
            : idleMessage)}
      </p>
      {verification ? (
        <dl className={styles.receiptFacts}>
          <div><dt>Final score</dt><dd>{verification.score ?? "Not final"}</dd></div>
          <div><dt>Winner</dt><dd>{verification.winnerLabel ?? "Pending"}</dd></div>
          <div><dt>Receipt</dt><dd>{compactHash(verification.receiptHash)}</dd></div>
          <div><dt>Score sequence</dt><dd>{verification.scoreSequence ?? "Pending"}</dd></div>
        </dl>
      ) : null}
      {verification ? (
        <div className={styles.receiptLinks}>
          <a href={verification.evidenceUrl} target="_blank" rel="noreferrer">
            Inspect evidence JSON
          </a>
          <a href={verification.productUrl} target="_blank" rel="noreferrer">
            Open SettleTrace
          </a>
        </div>
      ) : null}
      <p className={styles.receiptBoundary}>
        {historical
          ? "Historical, authenticated TxLINE evidence — not synthetic and not the current match."
          : "This proves the final match result. It does not change your earlier pulse score or prove when your device-local pick was made."}
      </p>
    </article>
  );
}

export function FanPulse() {
  const [fixtures, setFixtures] = useState<TxLineFixture[]>([]);
  const [fixtureState, setFixtureState] = useState<LoadState>("loading");
  const [selectedFixtureId, setSelectedFixtureId] = useState<number | null>(null);
  const [markets, setMarkets] = useState<TxLineMarket[]>([]);
  const [scoreEvents, setScoreEvents] = useState<TxLineScoreEvent[]>([]);
  const [marketState, setMarketState] = useState<LoadState>("empty");
  const [network, setNetwork] = useState("devnet");
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [previousView, setPreviousView] = useState<FanMarketView | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [draftPicks, setDraftPicks] = useState<Record<number, string>>({});
  const [pickRecords, setPickRecords] = useState<PickRecord[]>([]);
  const [shareStatuses, setShareStatuses] = useState<Record<number, string>>({});
  const [announcement, setAnnouncement] = useState("");
  const [replayFrame, setReplayFrame] = useState(0);
  const [selectedVerification, setSelectedVerification] =
    useState<VerificationPanelState>(IDLE_VERIFICATION_PANEL);
  const [exampleVerification, setExampleVerification] = useState<VerificationPanelState>({
    state: "loading",
    data: null,
  });
  const latestViews = useRef(new Map<number, FanMarketView>());

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        setPickRecords(
          safePickRecords(JSON.parse(localStorage.getItem(PICK_STORAGE_KEY) ?? "[]")),
        );
      } catch {
        setPickRecords([]);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    requestVerification("/api/final-result?example=completed", controller.signal)
      .then((data) => setExampleVerification({ state: "ready", data }))
      .catch((error: Error) => {
        if (error.name !== "AbortError") {
          setExampleVerification({ state: "error", data: null });
        }
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function loadFixtures() {
      setFixtureState("loading");
      try {
        const response = await fetch("/api/txline", {
          signal: controller.signal,
          cache: "no-store",
        });
        const body = (await response.json()) as {
          mode?: string;
          network?: string;
          fixtures?: TxLineFixture[];
        };
        if (!response.ok || body.mode !== "authenticated-snapshot") {
          throw new Error("fixture_snapshot_unavailable");
        }
        const rows = Array.isArray(body.fixtures) ? body.fixtures : [];
        setFixtures(rows);
        setNetwork(body.network || "devnet");
        setFixtureState(rows.length ? "ready" : "empty");
        setSelectedFixtureId((current) =>
          rows.some((fixture) => fixture.fixtureId === current)
            ? current
            : rows[0]?.fixtureId ?? null,
        );
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setFixtureState("error");
      }
    }
    loadFixtures();
    return () => controller.abort();
  }, []);

  const selectedFixture = useMemo(
    () => fixtures.find((fixture) => fixture.fixtureId === selectedFixtureId),
    [fixtures, selectedFixtureId],
  );

  useEffect(() => {
    if (!selectedFixture) return;
    const controller = new AbortController();
    const fixture = selectedFixture;
    const fixtureId = fixture.fixtureId;
    async function loadFixturePulse() {
      setMarketState("loading");
      try {
        const response = await fetch(`/api/txline?fixtureId=${fixtureId}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const body = (await response.json()) as {
          mode?: string;
          network?: string;
          fetchedAt?: number;
          markets?: TxLineMarket[];
          scoreEvents?: TxLineScoreEvent[];
        };
        if (!response.ok || body.mode !== "authenticated-snapshot") {
          throw new Error("fixture_pulse_unavailable");
        }
        const nextMarkets = Array.isArray(body.markets) ? body.markets : [];
        const nextScores = Array.isArray(body.scoreEvents) ? body.scoreEvents : [];
        const nextView = buildFanMarketView(fixture, nextMarkets);
        const storedView = latestViews.current.get(fixtureId) ?? null;
        setPreviousView(storedView);
        if (
          nextView &&
          (!storedView ||
            storedView.marketKey !== nextView.marketKey ||
            storedView.sourceAt !== nextView.sourceAt)
        ) {
          latestViews.current.set(fixtureId, nextView);
          if (storedView?.sourceAt && nextView.sourceAt) {
            setAnnouncement(
              `New authenticated source update for ${fixtureLabel(fixture)}.`,
            );
          }
        }
        setMarkets(nextMarkets);
        setScoreEvents(nextScores);
        setFetchedAt(body.fetchedAt ?? Date.now());
        setNetwork(body.network || "devnet");
        setMarketState(nextMarkets.length || nextScores.length ? "ready" : "empty");
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        setMarketState("error");
        setMarkets([]);
        setScoreEvents([]);
      }
    }
    loadFixturePulse();
    return () => controller.abort();
  }, [refreshToken, selectedFixture]);

  useEffect(() => {
    if (!selectedFixture) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        setRefreshToken((value) => value + 1);
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [selectedFixture]);

  const fanView = useMemo(
    () => (selectedFixture ? buildFanMarketView(selectedFixture, markets) : null),
    [markets, selectedFixture],
  );
  const insight = useMemo(
    () =>
      selectedFixture
        ? buildFanInsight(selectedFixture, fanView, previousView)
        : null,
    [fanView, previousView, selectedFixture],
  );
  const scoreStory = useMemo(
    () =>
      selectedFixture
        ? buildScoreStory(selectedFixture, scoreEvents)
        : null,
    [scoreEvents, selectedFixture],
  );
  const selectedRecord = pickRecords.find(
    (record) => record.fixtureId === selectedFixtureId,
  );
  const pick =
    selectedRecord?.pick ??
    (selectedFixtureId === null ? "" : draftPicks[selectedFixtureId] ?? "");
  const revealed = Boolean(selectedRecord);
  const shareStatus =
    selectedFixtureId === null ? "" : shareStatuses[selectedFixtureId] ?? "";
  const localScore = pickRecords.reduce(
    (score, record) => score + (record.correct ? 1 : 0),
    0,
  );

  useEffect(() => {
    if (!selectedFixtureId || !selectedRecord) return;
    const controller = new AbortController();
    const fixtureId = selectedFixtureId;
    requestVerification(
      `/api/final-result?fixtureId=${fixtureId}`,
      controller.signal,
    )
      .then((data) => {
        setSelectedVerification({ state: "ready", data, fixtureId });
        if (data.status === "verified") {
          setAnnouncement(`Verified final result is ready for ${data.fixtureLabel}.`);
        }
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") {
          setSelectedVerification({ state: "error", data: null, fixtureId });
        }
      });
    return () => controller.abort();
  }, [selectedFixtureId, selectedRecord]);

  const selectedVerificationPanel: VerificationPanelState =
    !selectedRecord
      ? IDLE_VERIFICATION_PANEL
      : selectedVerification.fixtureId === selectedFixtureId
        ? selectedVerification
        : { state: "loading", data: null };

  function updateShareStatus(value: string) {
    if (selectedFixtureId === null) return;
    setShareStatuses((current) => ({
      ...current,
      [selectedFixtureId]: value,
    }));
  }

  function storeRecords(records: PickRecord[]) {
    setPickRecords(records);
    try {
      localStorage.setItem(PICK_STORAGE_KEY, JSON.stringify(records));
    } catch {
      // The core experience remains available when storage is blocked.
    }
  }

  function revealPulse() {
    if (!selectedFixture || !fanView || !insight?.leader || !pick) return;
    const pickOutcome = fanView.outcomes.find((outcome) => outcome.key === pick);
    if (!pickOutcome) return;
    const record: PickRecord = {
      fixtureId: selectedFixture.fixtureId,
      pick,
      pickLabel: pickOutcome.label,
      leader: insight.leader.label,
      correct: pick === insight.leader.key,
      sourceAt: fanView.sourceAt,
    };
    storeRecords([
      ...pickRecords.filter((item) => item.fixtureId !== selectedFixture.fixtureId),
      record,
    ]);
  }

  async function sharePick() {
    if (!selectedFixture || !insight || !pick) return;
    const pickLabel =
      fanView?.outcomes.find((outcome) => outcome.key === pick)?.label ?? pick;
    const text = `${fixtureLabel(selectedFixture)} — my FanPulse pick: ${pickLabel}. ${
      insight.headline
    }. Authenticated TxLINE ${network} snapshot; no stakes and no betting execution.`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "FanPulse", text, url: window.location.href });
        updateShareStatus("Shared.");
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(`${text} ${window.location.href}`);
        updateShareStatus("Share text copied.");
      } else {
        updateShareStatus("Sharing is not supported in this browser.");
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        updateShareStatus("Sharing was not completed.");
      }
    }
  }

  const replay = REPLAY_FRAMES[replayFrame];

  return (
    <main className={styles.page}>
      <p className={styles.srStatus} aria-live="polite">
        {announcement}
      </p>
      <header className={styles.header}>
        <a className={styles.brand} href="#top" aria-label="FanPulse home">
          <span className={styles.brandMark} aria-hidden="true">FP</span>
          <span>
            <strong>FanPulse</strong>
            <small>World Cup second screen</small>
          </span>
        </a>
        <div className={styles.headerMeta}>
          <span className={styles.localScore}>Pulse score · {localScore}/{pickRecords.length}</span>
          <a href="#how-it-works">How it works</a>
        </div>
      </header>

      <section className={styles.hero} id="top">
        <div className={styles.heroCopy}>
          <p className={styles.eyebrow}>AUTHENTICATED MATCH MOMENTS · NO-STAKES FAN PICKS</p>
          <h1>The match story behind the market.</h1>
          <p>
            Pick the outcome you think the current market leans toward. FanPulse
            reveals the authenticated TxLINE snapshot, explains what changed, and
            tells you when the evidence is incomplete, then closes finished matches with a
            hash-checked SettleTrace result receipt.
          </p>
          <div className={styles.heroPills} aria-label="Product principles">
            <span>Phone first</span>
            <span>No wallet required</span>
            <span>No bets or profit claims</span>
            <span>Verified final results</span>
          </div>
        </div>
        <aside className={styles.sourceCard} aria-label="Data source status">
          <span className={styles.liveDot} aria-hidden="true" />
          <small>DATA SOURCE</small>
          <strong>TxLINE {network.toUpperCase()}</strong>
          <p>Server-authenticated snapshots, plus a fail-closed final-result proof gate.</p>
          <time dateTime={fetchedAt ? new Date(fetchedAt).toISOString() : undefined}>
            Retrieved {formatSourceTime(fetchedAt)}
          </time>
        </aside>
      </section>

      <section className={styles.fixtureSection} aria-labelledby="fixture-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.kicker}>01 · CHOOSE THE MATCH</p>
            <h2 id="fixture-heading">Your World Cup pulse</h2>
          </div>
          <button
            className={styles.refreshButton}
            type="button"
            onClick={() => setRefreshToken((value) => value + 1)}
            disabled={!selectedFixture || marketState === "loading"}
          >
            {marketState === "loading" ? "Refreshing…" : "Refresh now"}
          </button>
        </div>

        {fixtureState === "loading" ? (
          <div className={styles.loadingCard} role="status">Loading authenticated fixtures…</div>
        ) : fixtureState === "error" ? (
          <div className={styles.errorCard} role="status">
            FanPulse could not reach the authenticated fixture list. Try again shortly.
          </div>
        ) : fixtureState === "empty" ? (
          <div className={styles.loadingCard} role="status">
            No World Cup fixture is available in the current authenticated snapshot.
          </div>
        ) : (
          <div className={styles.fixtureRail}>
            {fixtures.map((fixture) => (
              <button
                className={`${styles.fixtureButton} ${
                  fixture.fixtureId === selectedFixtureId ? styles.fixtureSelected : ""
                }`}
                type="button"
                key={fixture.fixtureId}
                aria-pressed={fixture.fixtureId === selectedFixtureId}
                onClick={() => setSelectedFixtureId(fixture.fixtureId)}
              >
                <span>{fixture.competition}</span>
                <strong>{fixture.participant1} <i>vs</i> {fixture.participant2}</strong>
                <small>{fixtureKickoff(fixture.startTime)}</small>
              </button>
            ))}
          </div>
        )}
      </section>

      {selectedFixture ? (
        <section className={styles.experienceGrid}>
          <article className={styles.pickCard}>
            <div className={styles.cardTopline}>
              <span>02 · MAKE YOUR PULSE PICK</span>
              <span>{fanView?.marketLabel ?? "Waiting for a market"}</span>
            </div>
            <div className={styles.matchTitle}>
              <div>
                <small>{scoreStory?.phase}</small>
                <strong>{selectedFixture.participant1}</strong>
              </div>
              <span className={styles.score}>{scoreStory?.score ?? "—"}</span>
              <div>
                <small>{fixtureKickoff(selectedFixture.startTime)}</small>
                <strong>{selectedFixture.participant2}</strong>
              </div>
            </div>
            <p className={styles.momentLine}>{scoreStory?.moment}</p>

            {fanView?.outcomes.length ? (
              <fieldset className={styles.pickFieldset} disabled={revealed}>
                <legend>Who leads this market pulse?</legend>
                <div className={styles.pickOptions}>
                  {fanView.outcomes.map((outcome) => (
                    <label key={outcome.key}>
                      <input
                        type="radio"
                        name="fan-pick"
                        value={outcome.key}
                        checked={pick === outcome.key}
                        onChange={(event) => {
                          if (selectedFixtureId === null) return;
                          setDraftPicks((current) => ({
                            ...current,
                            [selectedFixtureId]: event.target.value,
                          }));
                        }}
                      />
                      <span>{outcome.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : (
              <div className={styles.noPick}>
                The current market does not include a complete probability vector, so
                FanPulse will not manufacture a pick.
              </div>
            )}

            {!revealed ? (
              <button
                className={styles.revealButton}
                type="button"
                onClick={revealPulse}
                disabled={!pick || !fanView?.outcomes.length || marketState === "loading"}
              >
                Reveal the authenticated pulse
              </button>
            ) : (
              <div className={styles.pickResult}>
                <span>{selectedRecord?.correct ? "You matched the pulse" : "The pulse leaned elsewhere"}</span>
                <strong>
                  Your pick: {selectedRecord?.pickLabel} · Current leader: {insight?.leader?.label}
                </strong>
                <small>No stakes. This compares your choice with one authenticated snapshot.</small>
              </div>
            )}
          </article>

          <aside className={styles.storyCard} aria-live="polite">
            <div className={styles.cardTopline}>
              <span>03 · READ THE STORY</span>
              <span className={`${styles.qualityBadge} ${styles[`quality_${insight?.state ?? "waiting"}`]}`}>
                {insight?.state === "probability"
                  ? fanView?.providerCount === 1
                    ? "Single source"
                    : "Corroborated"
                  : insight?.state === "raw-only"
                    ? "Raw only"
                    : "Forming"}
              </span>
            </div>
            {revealed ? (
              <>
                <h2>{insight?.headline}</h2>
                <p className={styles.storyLead}>{insight?.explanation}</p>
                <div className={styles.probabilityBars}>
                  {fanView?.outcomes.map((outcome) => (
                    <div key={outcome.key} className={styles.probabilityRow}>
                      <div>
                        <span>{outcome.label}</span>
                        <strong>{(outcome.probability * 100).toFixed(1)}%</strong>
                      </div>
                      <div className={styles.barTrack}>
                        <span
                          style={{ width: `${Math.max(2, outcome.probability * 100)}%` }}
                          aria-hidden="true"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className={styles.hiddenStory}>
                <span aria-hidden="true">?</span>
                <h2>Make a pick to reveal the current pulse.</h2>
                <p>The probabilities stay hidden until you choose. Nothing is wagered.</p>
              </div>
            )}
            <div className={styles.storyNotes}>
              <p><strong>What changed</strong>{insight?.change}</p>
              <p><strong>Evidence check</strong>{insight?.trust}</p>
              <p><strong>Source time</strong>{formatSourceTime(fanView?.sourceAt ?? null)}</p>
            </div>
            {revealed ? (
              <div className={styles.shareRow}>
                <button type="button" onClick={sharePick}>Share my pick</button>
                <span role="status">{shareStatus}</span>
              </div>
            ) : null}
          </aside>
        </section>
      ) : null}

      <section className={styles.receiptSection} aria-labelledby="receipt-heading">
        <div className={styles.receiptHeading}>
          <div>
            <p className={styles.kicker}>04 · CLOSE THE LOOP</p>
            <h2 id="receipt-heading">A result badge that earns its word “verified.”</h2>
          </div>
          <p>
            FanPulse waits for finality, verifies the canonical receipt SHA-256 on the
            server, and fails closed if the fixture, winner, score sequence, predicate,
            or execution boundary does not match.
          </p>
        </div>
        <div className={styles.receiptGrid}>
          <ResultReceiptCard
            eyebrow="YOUR SELECTED MATCH · FINAL RESULT"
            panel={selectedVerificationPanel}
            idleMessage="Reveal a pulse pick first. The result gate stays separate from your device-local pulse score."
          />
          <ResultReceiptCard
            eyebrow="COMPLETED PROOF EXAMPLE · LIVE DATA"
            panel={exampleVerification}
            idleMessage="Loading a completed, independently verifiable result example."
            historical
          />
        </div>
      </section>

      <section className={styles.replaySection} id="how-it-works">
        <div className={styles.replayIntro}>
          <p className={styles.kicker}>CLEARLY LABELLED FALLBACK</p>
          <h2>Replay a match moment</h2>
          <p>
            This fictional sequence demonstrates how the interface reacts when
            fresh probabilities move. It is synthetic and never presented as current TxLINE state.
          </p>
          <button
            type="button"
            onClick={() => setReplayFrame((value) => (value + 1) % REPLAY_FRAMES.length)}
          >
            Next replay moment
          </button>
        </div>
        <div className={styles.replayCard}>
          <div className={styles.syntheticLabel}>SYNTHETIC DEMONSTRATION · NOT CURRENT DATA</div>
          <span className={styles.replayStep}>0{replayFrame + 1} / 03 · {replay.label}</span>
          <h3>Blue City <i>vs</i> Gold United</h3>
          <p>{replay.note}</p>
          <div className={styles.replayBars}>
            {replay.values.map((value, index) => (
              <div key={replayLabels[index]}>
                <span>{replayLabels[index]}</span>
                <div><i style={{ width: `${value}%` }} /></div>
                <strong>{value}%</strong>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.businessSection}>
        <div>
          <p className={styles.kicker}>FROM FAN FEATURE TO MEDIA PRODUCT</p>
          <h2>Built for watch parties. Ready for publishers.</h2>
        </div>
        <div className={styles.businessCards}>
          <article><span>FREE</span><strong>Match companion</strong><p>One-tap picks and honest market explanations for every covered match.</p></article>
          <article><span>PREMIUM</span><strong>Group rooms</strong><p>Private no-stakes leaderboards, alerts, and multi-match watchlists.</p></article>
          <article><span>B2B</span><strong>Publisher widget</strong><p>White-label moment cards, localization, sponsorship, and editorial controls.</p></article>
        </div>
      </section>

      <footer className={styles.footer}>
        <div><strong>FanPulse</strong><span>Authenticated TxLINE snapshots, translated for fans.</span></div>
        <p>No betting execution. No guaranteed outcomes. No hidden probability inference.</p>
      </footer>
    </main>
  );
}
