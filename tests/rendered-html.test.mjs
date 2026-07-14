import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("builds the complete FanPulse experience and server entry", async () => {
  const [page, client] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/fanpulse.tsx", import.meta.url), "utf8"),
    access(new URL("../dist/server/index.js", import.meta.url)),
  ]);
  assert.match(page, /FanPulse — The match story behind the market/);
  assert.match(client, /The match story behind the market\./);
  assert.match(client, /AUTHENTICATED MATCH MOMENTS/);
  assert.match(client, /SYNTHETIC DEMONSTRATION · NOT CURRENT DATA/);
  assert.match(client, /No betting execution/);
  assert.doesNotMatch(client, /Your site is taking shape|Codex is working|codex-preview/);
});

test("keeps TxLINE credentials behind the server route", async () => {
  const [route, client, envExample, gitignore] = await Promise.all([
    readFile(new URL("../app/api/txline/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/fanpulse.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
    readFile(new URL("../.gitignore", import.meta.url), "utf8"),
  ]);
  assert.match(route, /"X-Api-Token"/);
  assert.match(route, /worldCupFixtures/);
  assert.match(route, /FIXTURE_NOT_AVAILABLE/);
  assert.match(client, /fetch\("\/api\/txline"/);
  assert.doesNotMatch(client, /TXLINE_API_TOKEN|X-Api-Token|Authorization/);
  assert.match(envExample, /^TXLINE_API_TOKEN=\s*$/m);
  assert.match(gitignore, /^\.env\*$/m);
  assert.match(gitignore, /^!\.env\.example$/m);
  await access(new URL("../dist/server/index.js", import.meta.url));
});
