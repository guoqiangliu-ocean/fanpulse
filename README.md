# FanPulse

FanPulse is a phone-first World Cup second-screen companion. A fan chooses an
outcome before revealing the current authenticated TxLINE market snapshot, then
gets a plain-language explanation of the market leader, the change since the
previous exact-series source update, and the limits of the available evidence.

The interaction is no-stakes. FanPulse does not execute bets, recommend wagers,
predict guaranteed outcomes, or infer probabilities from raw prices.

## Why this is a separate product

FanPulse was created for the TxODDS Consumer and Fan Experiences track. It has
its own consumer journey, source repository, deployment, visual system, demo,
and submission. It does not reuse the OddPulse trading dashboard. The shared
idea is limited to a server-only TxLINE credential boundary and conservative
data-provenance rules.

## Product loop

1. Load the authenticated World Cup fixture list.
2. Choose a match from a mobile-friendly match rail.
3. Read the latest safe score context when TxLINE supplies it.
4. Make a no-stakes pulse pick before probabilities are revealed.
5. Reveal the exact current market snapshot and compare the pick with its
   leading outcome.
6. See whether the same market series changed on the next source update.
7. When a match finishes, check its final-result receipt through a separate
   proof gate.
8. Share the pick through the Web Share API or a clipboard fallback.

Picks and the local score remain on the user's device. There is no global fan
leaderboard and no claim that local picks represent crowd sentiment.

The pulse score measures whether a fan matched the **current market leader** at
reveal time. It is deliberately separate from the eventual match result and is
never rewritten by the final-result receipt.

## TxLINE integration

The browser calls the same-origin `/api/txline` route. The route keeps the API
token and guest JWT on the server, restricts fixture access to the authenticated
World Cup allowlist, coalesces concurrent requests, caches upstream snapshots
briefly, retries once after an authentication failure, and returns only the
public fields required by the interface.

Endpoints used:

- `POST /auth/guest/start`
- `GET /api/fixtures/snapshot`
- `GET /api/odds/snapshot/{fixtureId}`
- `GET /api/scores/snapshot/{fixtureId}`

The app refreshes the selected fixture every 15 seconds only while the browser
tab is visible. The server caches fixture metadata for 60 seconds and fixture
score/odds snapshots for 12 seconds to reduce duplicate upstream calls.

## Verified final results

After a fan reveals the market pulse, the browser may call the same-origin
`/api/final-result?fixtureId=...` route. It does not accept the fan's pick. The
route calls SettleTrace through a private Cloudflare Service Binding, determines
the actual winning selection from the final score, then fetches that winner's
predicate only when the initial selection lost. The public SettleTrace URL is
used only for the evidence link shown in the resulting receipt.

Before the UI can say `HASH VERIFIED`, FanPulse requires a resolved final score,
the matching winner predicate, on-chain proof, a ready consumer envelope with
no submitted transaction, and exact agreement among fixture ID, score sequence,
final score, predicate, outcome, and receipt hash. It also recomputes the
SHA-256 of SettleTrace's recursive-key-sorted canonical receipt body. Any
mismatch stays pending or unavailable.

This proof confirms a final match result. It does not execute settlement, prove
when a device-local fan pick was made, or alter the pulse score.

`/api/final-result?example=completed` provides one clearly labelled historical
World Cup example. It is authenticated live evidence, not a synthetic replay
and not presented as the currently selected match.

The `SETTLETRACE` binding is configured in the Worker deployment, so no
SettleTrace credential or public-origin override is placed in `.env` files.

## Evidence rules

- Only `mode=authenticated-snapshot` can power the current-match experience.
- World Cup fixtures are selected from authenticated fixture metadata rather
  than hard-coded IDs.
- Participant outcomes are mapped from `Participant1` and `Participant2`, never
  guessed from home/away ordering.
- The preferred fan market is a complete full-match 1X2 probability vector.
  Any fallback period or line remains visible in the label.
- A percentage vector is accepted only when every outcome is present and the
  complete vector has a coherent fraction or percent scale.
- Mixed scales, incomplete vectors, non-finite values, and `NA` values make the
  entire probability vector unavailable.
- Raw prices remain raw; FanPulse never divides them by an assumed scale.
- Change is compared only across the same market, period, parameters,
  in-running flag, game state, and outcome.
- One provider is labelled `Single source`, never market consensus.
- `In play` is shown only when the odds record explicitly sets
  `inRunning=true`.
- Source time and retrieval time remain separate.
- The final-result card fails closed unless finality, proof, canonical hash,
  fixture, score, and winner checks all agree.
- Receipt verification currently accepts only fixtures where
  `participant1IsHome` is explicitly true, so the public participant mapping
  cannot silently diverge from the canonical home/away predicate.

The replay section uses fictional teams and deterministic synthetic values. It
is labelled on the card itself and is never mixed into the authenticated view.

## Architecture

```text
TxLINE Devnet
  ├─ fixtures snapshot
  ├─ odds snapshot
  └─ scores snapshot
          │
          ▼
server-only authenticated adapter
  ├─ World Cup fixture allowlist
  ├─ request coalescing and short cache
  ├─ safe probability-vector validation
  └─ score and market field whitelist
          │
          ▼
FanPulse browser experience
  ├─ mobile match selection
  ├─ no-stakes pulse pick
  ├─ current market explanation
  ├─ exact-series update comparison
  ├─ device-local score
  └─ Web Share / clipboard fallback

SettleTrace Worker
          │
          ▼
FanPulse same-origin final-result route
  ├─ private Cloudflare Service Binding
  ├─ resolve actual winner from final score
  ├─ verify canonical receipt SHA-256
  ├─ reject mismatched fixture / predicate / sequence
  └─ return a minimal proof summary only
          │
          ▼
Final-result receipt card (separate from pulse score)
```

## Local development

Requirements: Node.js 22.13 or newer.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Set the activated TxLINE credential only in `.env.local` or the deployment's
server-side secret store. Never commit it.

## Validation

```bash
npm test
npm run lint
```

The automated suite covers coherent percent/fraction vectors, mixed-scale and
incomplete rejection, participant mapping, full-match market selection,
multi-provider aggregation, raw-only behavior, exact-series change isolation,
score-story output, server rendering, disclosure labels, the server-only
credential boundary, final-result pending states, winner selection, canonical
receipt SHA-256 validation, and fail-closed route behavior.

## Privacy and security

- No analytics, advertising trackers, cookies, wallet connection, or personal
  profile is required.
- API tokens, guest JWTs, authorization headers, wallet material, and personal
  information are excluded from browser state and public output.
- Device-local picks contain only fixture IDs, public outcome labels, and a
  correct/incorrect comparison with the revealed snapshot.
- The final-result route returns a whitelisted summary rather than upstream
  proof payloads, account metadata, RPC errors, or transaction construction
  data. A historical reference transaction, when one exists upstream, is never
  treated as a transaction submitted by FanPulse.
- The worker sets a restrictive Content Security Policy, blocks framing, and
  disables camera, microphone, geolocation, payment, and USB permissions.
- Upstream error details are replaced with stable public error codes.

## Business path

FanPulse can remain free for individual fans while supporting paid private group
rooms, multi-match alerts, and a white-label widget for broadcasters, clubs, and
sports publishers. Commercial value comes from the consumer software and
editorial layer, not from reselling TxLINE data. Continued post-hackathon use
would require appropriate TxLINE data rights.

## TxLINE feedback

The strongest feature is the combination of fixture, score, and odds snapshots
under one normalized authenticated interface. It makes it possible to connect a
match moment with a clearly identified market state without exposing server
credentials to the fan.

The main friction is uneven snapshot availability across fixtures, incomplete
probability vectors on some markets, and limited multi-provider coverage in the
current Devnet sample. A compact consumer example that joins fixture, score,
and odds snapshots by fixture ID would accelerate second-screen products.

## Status

- Independent FanPulse product: complete; proof-receipt release verification in progress
- Public repository: [github.com/guoqiangliu-ocean/fanpulse](https://github.com/guoqiangliu-ocean/fanpulse)
- Public deployment: [fanpulse-world-cup.oddpulse-txline-2026.workers.dev](https://fanpulse-world-cup.oddpulse-txline-2026.workers.dev/)
- Separate demo video: [watch the 4:42 walkthrough](https://fanpulse-world-cup.oddpulse-txline-2026.workers.dev/demo)
- Superteam Consumer and Fan Experiences submission: submitted on 2026-07-14

## Deployment check

Build and deploy through the existing Cloudflare Worker workflow. The TxLINE
secret is already provisioned and must not be printed or re-entered during an
ordinary release. After deployment, check `/`, `/demo`, `/api/txline`, and
`/api/final-result?example=completed`. The final endpoint must return a minimal
`verification` object, `Cache-Control: no-store`, and no credential, proof
payload, or raw upstream-error field.

## License

MIT © 2026 Guoqiang Liu
