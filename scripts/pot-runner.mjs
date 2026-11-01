#!/usr/bin/env node
/**
 * pot-runner v1 (DRAFT): one sworn-escrow round, end to end. Vision 2026-11-01.
 *
 *   deploy (or attach) → entries close at the pot's closeTime → race result from the fōmz board mirror
 *   → settle <winner> → reveal (local winners) → claim      or      cancel → refund (every local ticket)
 *
 * Rules
 *   - Every step reads pot state first. A step that state shows done ("already paid", already cancelled, …) counts as success; nothing is sent.
 *   - Nothing is resent blind. A retry is a fresh build, only after a state re-read shows the step is still not done.
 *     If the child said the outcome is unknown ("may still land"), the runner keeps polling state for 4 min first.
 *   - Deploy is the one step with no state to read, so it gets one try. If the pot file is missing afterwards, check the explorer
 *     before deploying again.
 *   - Every tx is logged as: TX <step> · explorer hash <64 hex> · ledger id <66 hex> · block <n> · <status>.
 *     A missing half is looked up on the indexer.
 *   - One runner per repo (logs/pot-runner.lock). All output is masked (mask-stdio.mjs).
 *     The run log goes to logs/pot-runner-<UTC>.log (gitignored).
 *
 * Usage (from ~/workspace/sworn-escrow)
 *   node scripts/pot-runner.mjs --path self|ng --pot <file> [--deploy <stakeNight> <closeISO> <settleByISO> <claimFromISO>]
 *                               [--race <raceId>] [--players a,b] [--players-dir <dir>]
 *   DRY=1 …                                prints every step and sends nothing: no child process runs, waits are skipped
 *                                          (simulated clock). It still reads live pot state from the indexer.
 *   DRY=1 … --state-file <fixture.json>    no network at all: pot state + players come from the fixture.
 *                                          NOW=<ISO> sets the simulated start time.
 *
 * --path self  scripts/escrow-self.mjs in this repo (own wallet pays DUST). POT_FILE=<pot>, PLAYERS_DIR (default .players-self).
 * --path ng    references/escrow-ng.mjs in ~/workspace/halfhand-notary (NIGHTGATE sponsors; enter/claim self-funded there).
 *              escrow-ng only knows deployment.json and .players-ng, so --pot must be deployment.json.
 *              An ng deploy (deploy-escrow-nightgate.mjs) writes deployment.json, so the runner refuses it while that file exists.
 * Board: BOARD (default the vault mirror vision/pig-laps/fomz-board/latest.json).
 *   Race = --race, else the first race whose gate time is between the pot's close and settleBy.
 *   Winner = the single eligible place-1 result. A cancelled race, no single winner, or no result by settleBy − VERDICT_CUTOFF_MIN
 *   (default 12) → cancel.
 */
import "./mask-stdio.mjs";
import { redact } from "./mask-stdio.mjs";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";

const ESC = resolve(new URL("..", import.meta.url).pathname);
const NOTARY = process.env.NOTARY_DIR ?? join(homedir(), "workspace", "halfhand-notary");
const BOARD = process.env.BOARD ?? join(homedir(), "Library/CloudStorage/Dropbox/Zion/vision/pig-laps/fomz-board/latest.json");
const DRY = process.env.DRY === "1";
const MAX_TRIES = Number(process.env.MAX_TRIES ?? 2);
const MARGIN_MS = 60_000;                                            // block time lags the wall clock
const VERDICT_CUTOFF_MIN = Number(process.env.VERDICT_CUTOFF_MIN ?? 12);  // settle/cancel need a few minutes to prove + land
const MIRROR_LAG_MIN = Number(process.env.MIRROR_LAG_MIN ?? 5);          // fixture mode: board shows a result this long after the race ends
const CHILD_TIMEOUT_MIN = Number(process.env.CHILD_TIMEOUT_MIN ?? 30);

const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const usage = (why) => { console.error(`${why}\nusage: node scripts/pot-runner.mjs --path self|ng --pot <file> [--deploy <stakeNight> <closeISO> <settleByISO> <claimFromISO>] [--race <id>] [--players a,b] [--players-dir <dir>] [--state-file <fixture>]`); process.exit(2); };
const PATH = opt("path"); if (!["self", "ng"].includes(PATH)) usage("--path self|ng is required");
const POT = resolve(ESC, opt("pot") ?? (PATH === "ng" ? "deployment.json" : "")); if (!opt("pot") && PATH === "self") usage("--pot <file> is required for --path self");
const di = argv.indexOf("--deploy"); const DEPLOY = di >= 0 ? argv.slice(di + 1, di + 5) : null;
const RACE = opt("race"), ONLY = opt("players")?.split(",").filter(Boolean), FIXTURE = opt("state-file");
const PDIR = resolve(ESC, opt("players-dir") ?? (PATH === "ng" ? ".players-ng" : ".players-self"));
if (PATH === "ng" && basename(POT) !== "deployment.json") usage("--path ng: escrow-ng.mjs only reads deployment.json");
if (FIXTURE && !DRY) usage("--state-file only works with DRY=1");

// ---------- clock + log ----------
const clock = { t: process.env.NOW ? Date.parse(process.env.NOW) : Date.now(), now() { return DRY ? this.t : Date.now(); } };
const pt = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) + " PT";
mkdirSync(join(ESC, "logs"), { recursive: true });
const RUNLOG = join(ESC, "logs", `pot-runner-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 13)}Z${DRY ? "-dry" : ""}.log`);
function log(m) { const line = `[${pt(clock.now())}] ${m}`; console.log(line); try { appendFileSync(RUNLOG, redact(line) + "\n"); } catch { /* log file is best effort */ } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (p) => String(p).replace(ESC + "/", "").replace(homedir(), "~");
const racerHex = (name) => createHash("sha256").update(`sworn-escrow:racer:v0:${String(name).normalize("NFC").trim().toLowerCase()}`).digest("hex");   // same as escrow-self racer()
const raw = (x) => (x / 1_000_000n).toString() + (x % 1_000_000n ? "." + String(x % 1_000_000n).padStart(6, "0").replace(/0+$/, "") : "");

async function waitUntil(ms, why) {
  if (clock.now() >= ms) return;
  if (DRY) { log(`DRY would wait until ${pt(ms)} (${why})`); clock.t = ms; return; }
  log(`waiting until ${pt(ms)} (${why})`);
  while (Date.now() < ms) await sleep(Math.min(ms - Date.now(), 300_000));
}

// ---------- pot state: a fixture (DRY, no network) or the indexer ----------
function fixtureSource(fx) {
  const st = { ...fx.pot, entries: new Set(fx.entries ?? []), winners: new Set(fx.winners ?? []), paid: new Set(fx.paid ?? []) };
  return {
    kind: "fixture", players: fx.players ?? [], outcomes: fx.simulate ?? {},
    async read() {
      return { address: st.address, phase: st.phase, stake: BigInt(st.stakeRaw), entryCount: st.entries.size, rightCount: st.winners.size, winner: st.winner ?? null,
        closeMs: Date.parse(st.close), settleByMs: Date.parse(st.settleBy), claimFromMs: Date.parse(st.claimFrom),
        entered: (id) => st.entries.has(id), revealed: (id) => st.winners.has(id), paid: (id) => st.paid.has(id) };
    },
    apply(e) {   // what the step would do on chain
      if (e.kind === "settle") { st.phase = "settled"; st.winner = e.winner; }
      if (e.kind === "cancel") st.phase = "cancelled";
      if (e.kind === "reveal") st.winners.add(e.id);
      if (e.kind === "claim" || e.kind === "refund") st.paid.add(e.id);
    },
  };
}
async function liveSource(address) {
  const { WebSocket } = await import("ws"); globalThis.WebSocket = WebSocket;
  const EP = (await import("./endpoints.mjs")).loadEndpoints();
  if (EP.missing.length) throw new Error(`endpoints missing: ${EP.missing.join(", ")}`);
  const { setNetworkId } = await import("@midnight-ntwrk/midnight-js-network-id"); setNetworkId("preprod");
  const { indexerPublicDataProvider } = await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
  const C = await import("../contracts/managed/sworn-escrow/contract/index.js");
  const pub = indexerPublicDataProvider(EP.indexer, EP.indexerWS);
  const hex = (u) => Buffer.from(u).toString("hex"), u8 = (h) => new Uint8Array(Buffer.from(h, "hex"));
  return {
    kind: "live", EP, C,
    async read() {
      const cs = await pub.queryContractState(address); if (!cs) throw new Error(`no contract state at ${address.slice(0, 16)}…`);
      const L = C.ledger(cs.data);
      return { address, phase: Object.keys(C.Phase).find((k) => C.Phase[k] === L.phase), stake: L.stake, entryCount: Number(L.entryCount), rightCount: Number(L.rightCount),
        winner: L.phase === C.Phase.settled ? hex(L.winner) : null,
        closeMs: Number(L.closeTime) * 1000, settleByMs: Number(L.settleBy) * 1000, claimFromMs: Number(L.claimFrom) * 1000,
        entered: (id) => L.entries.member(u8(id)), revealed: (id) => L.winners.member(u8(id)), paid: (id) => L.paid.member(u8(id)) };
    },
    players() {   // local tickets for this pot; keys stay in memory, only name / pick / public player id are used
      if (!existsSync(PDIR)) return [];
      return readdirSync(PDIR).filter((f) => f.endsWith(".json")).map((f) => {
        const p = JSON.parse(readFileSync(join(PDIR, f), "utf8"));
        return p.contract === address ? { name: f.slice(0, -5), racer: p.racer, id: hex(C.pureCircuits.playerId(Buffer.from(p.sk, "hex"))) } : null;
      }).filter(Boolean);
    },
    async lookupTx(t) {   // fill the missing half (explorer hash ↔ ledger identifier) from the indexer
      const off = t.id ? `identifier:"${t.id}"` : `hash:"${t.hash}"`;
      const query = `{ transactions(offset:{${off}}) { hash block { height } ... on RegularTransaction { identifiers transactionResult { status } } } }`;
      try {
        const r = await fetch(EP.indexer, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15_000) });
        const x = (await r.json())?.data?.transactions?.[0]; if (!x) return t;
        return { ...t, hash: t.hash ?? x.hash, id: t.id ?? x.identifiers?.at(-1), block: t.block ?? x.block?.height, status: t.status ?? x.transactionResult?.status };
      } catch { return t; }
    },
  };
}

// ---------- the board ----------
function boardVerdict(S) {
  let b; try { b = JSON.parse(readFileSync(BOARD, "utf8")); } catch (e) { return { kind: "wait", text: `board unreadable (${e.message})` }; }
  const r = (b.races ?? []).filter((x) => (RACE ? x.id === RACE : x.gateMs >= S.closeMs && x.gateMs < S.settleByMs)).sort((a, c) => a.gateMs - c.gateMs)[0];
  if (!r) return { kind: "wait", text: `no race ${RACE ?? "with a gate between close and settleBy"} on the board yet` };
  const visibleAt = (r.endMs ?? 0) + MIRROR_LAG_MIN * 60_000;
  if (DRY && FIXTURE && r.endMs && clock.now() < visibleAt) return { kind: "wait", text: `${r.id} (gate ${pt(r.gateMs)}) not decided yet at this simulated time`, visibleAt };
  if (r.status === "cancelled") return { kind: "cancel", text: `${r.id} (gate ${pt(r.gateMs)}) CANCELLED: ${r.reason ?? "?"}` };
  if (r.status === "finished") {
    const top = (r.results ?? []).filter((x) => x.eligible && x.place === 1);
    if (top.length === 1) return { kind: "winner", name: top[0].name, text: `${r.id} (gate ${pt(r.gateMs)}) finished · winner ${top[0].name} ${Number(top[0].score).toFixed(2)} of ${r.results.length}` };
    return { kind: "cancel", text: `${r.id} finished with ${top.length} eligible place-1 results (need exactly 1)` };
  }
  return { kind: "wait", text: `${r.id} status ${r.status ?? "?"}` };
}
async function verdict(S) {
  const cutoff = S.settleByMs - VERDICT_CUTOFF_MIN * 60_000;
  for (;;) {
    const v = boardVerdict(S);
    if (v.kind !== "wait") { log(`board: ${v.text}`); return v; }
    if (clock.now() >= cutoff) { log(`board: ${v.text}; cutoff ${pt(cutoff)} (settleBy − ${VERDICT_CUTOFF_MIN} min) reached → cancel`); return { kind: "cancel" }; }
    if (DRY) { const t = Math.min(v.visibleAt ?? cutoff, cutoff); log(`board: ${v.text}; DRY would re-read the mirror every 60 s until ${pt(t)}`); clock.t = Math.max(clock.t, t); continue; }
    log(`board: ${v.text}; re-reading in 60 s`); await sleep(60_000);
  }
}

// ---------- child commands ----------
function cmd(mode, ...a) {
  return PATH === "self"
    ? { cwd: ESC, argv: ["node", "scripts/escrow-self.mjs", mode, ...a], env: { POT_FILE: short(POT), PLAYERS_DIR: short(PDIR) } }
    : { cwd: NOTARY, argv: ["node", "references/escrow-ng.mjs", mode, ...a], env: {} };
}
const show = (c) => `cd ${short(c.cwd)} && ${Object.entries(c.env).map(([k, v]) => `${k}=${v} `).join("")}${c.argv.map((x) => (/\s/.test(x) ? `'${x}'` : x)).join(" ")}`;
function runChild(c) {
  log(`run: ${show(c)}`);
  return new Promise((res) => {
    const ch = spawn(c.argv[0], c.argv.slice(1), { cwd: c.cwd, env: { ...process.env, ...c.env }, stdio: ["ignore", "pipe", "pipe"] });
    let text = "", part = "";
    const fwd = (d) => { const s = part + d.toString(); const lines = s.split("\n"); part = lines.pop(); text += lines.join("\n") + "\n"; for (const l of lines) if (l.trim()) log(`  │ ${l}`); };
    ch.stdout.on("data", fwd); ch.stderr.on("data", fwd);
    const kill = setTimeout(() => { log(`child still running after ${CHILD_TIMEOUT_MIN} min, stopping it`); ch.kill("SIGTERM"); }, CHILD_TIMEOUT_MIN * 60_000);
    ch.on("close", (code) => { clearTimeout(kill); if (part.trim()) { log(`  │ ${part}`); text += part; } log(`child exit ${code}`); res({ code, text }); });
  });
}
function parseTx(text) {
  const out = [];
  for (const m of text.matchAll(/TX \S+ · hash ([0-9a-f]{64}|\?) · id ([0-9a-f]{66}|\?) · block (\S+) · (\S+)/g))   // escrow-self
    out.push({ hash: m[1] === "?" ? null : m[1], id: m[2] === "?" ? null : m[2], block: m[3], status: m[4] });
  for (const m of text.matchAll(/LANDED · (?:block (\d+) · )?tx ([0-9a-f]{64,66})\b/g))                                 // escrow-ng
    out.push(m[2].length === 66 ? { id: m[2], block: m[1] ?? null } : { hash: m[2], block: m[1] ?? null });
  return out;
}

// ---------- one step: read state → done? → (DRY: print) → run once → re-read; retry only after a re-read ----------
const receipts = [];
const NO_RETRY = /judge only|not the winning pick|reveal does not match|claims not open yet|reveal window closed|share too|no entry|DIFFERENT winner|will not (settle|cancel)|could not balance dust|Insufficient Funds|endpoints missing|no player|entries are closed|another pot|not settled/i;
const UNKNOWN = /may still land|outcome unknown|not on the indexer|not visible on the indexer|timed out/i;
async function pollDone(src, isDone, ms) { const end = Date.now() + ms; for (;;) { if (isDone(await src.read())) return true; if (Date.now() > end) return false; await sleep(10_000); } }
async function step(src, { label, isDone, c, effect }) {
  for (let attempt = 1; attempt <= MAX_TRIES + 1; attempt++) {
    const S = await src.read();
    if (isDone(S)) { const how = attempt === 1 ? "already done on chain (state read) — nothing sent" : "done: the state re-read shows it landed — NOT resent"; log(`✓ ${label}: ${how}`); receipts.push({ label, result: attempt === 1 ? "already done" : "done (late landing)" }); return; }
    if (attempt > MAX_TRIES) break;
    if (attempt > 1) log(`${label}: state re-read says not done; retry ${attempt}/${MAX_TRIES} with a fresh build`);
    if (DRY) {
      log(`DRY would run: ${show(c)}`);
      const sim = src.outcomes?.[label] ?? "ok";
      if (sim === "ok") { src.apply?.(effect); log(`✓ ${label} (dry: assumed landed)`); receipts.push({ label, result: "dry" }); return; }
      if (sim === "timeout-landed") { src.apply?.(effect); log(`  (simulated: child lost its socket, outcome unknown, it LANDED anyway; the runner reads state before deciding)`); continue; }
      log(`  (simulated: child refused: ${sim})`); receipts.push({ label, result: `FAILED (${sim})` }); throw new Error(`${label}: ${sim}`);
    }
    const out = await runChild(c);
    for (const t of parseTx(out.text)) { const f = src.lookupTx ? await src.lookupTx(t) : t;
      log(`TX ${label} · explorer hash ${f.hash ?? "?"} · ledger id ${f.id ?? "?"} · block ${f.block ?? "?"} · ${f.status ?? "?"}`); receipts.push({ label, result: "tx", ...f }); }
    const wait = out.code === 0 ? 120_000 : UNKNOWN.test(out.text) ? 240_000 : 30_000;
    if (await pollDone(src, isDone, wait)) { log(`✓ ${label}: state confirms it`); receipts.push({ label, result: "done" }); return; }
    if (NO_RETRY.test(out.text)) { log(`${label}: refused for a reason a retry cannot fix`); break; }
  }
  receipts.push({ label, result: "FAILED" });
  throw new Error(`${label} failed; stopped. Read state, fix the cause, rerun the runner (finished steps are skipped).`);
}

// ---------- main ----------
const LOCK = join(ESC, "logs", "pot-runner.lock");
function lock() {
  if (DRY) return;
  if (existsSync(LOCK)) { const { pid } = JSON.parse(readFileSync(LOCK, "utf8")); try { process.kill(pid, 0); throw new Error(`another pot-runner is running (pid ${pid})`); } catch (e) { if (e.code !== "ESRCH") throw e; } }
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, pot: short(POT), at: new Date().toISOString() }));
  process.on("exit", () => { try { unlinkSync(LOCK); } catch { /* gone */ } });
}

async function main() {
  log(`pot-runner v1 · path ${PATH} · ${DRY ? "DRY: sends nothing" : "LIVE"} · pot ${short(POT)}${FIXTURE ? ` · fixture ${basename(FIXTURE)}` : ""}${DRY ? ` · simulated start ${pt(clock.t)}` : ""}`);
  lock();
  const fx = FIXTURE ? JSON.parse(readFileSync(FIXTURE, "utf8")) : null;

  // 1. deploy or attach
  if (DEPLOY) {
    const [stake, close, settleBy, claimFrom] = DEPLOY; if (!claimFrom) usage("--deploy needs <stakeNight> <closeISO> <settleByISO> <claimFromISO>");
    if (PATH === "self" && (basename(POT) === "deployment.json" || existsSync(POT))) throw new Error(`${short(POT)} exists or is deployment.json; deploy never overwrites. Attach instead (drop --deploy).`);
    if (PATH === "ng" && existsSync(POT)) throw new Error("deployment.json exists; deploy-escrow-nightgate.mjs would overwrite it. Attach to it, or deploy with --path self.");
    const c = PATH === "self" ? cmd("deploy", stake, close, settleBy, claimFrom) : { cwd: NOTARY, argv: ["node", "references/deploy-escrow-nightgate.mjs", stake, close, settleBy, claimFrom], env: {} };
    if (DRY) { log(`DRY would run (DUST): ${show(c)}`); receipts.push({ label: "deploy", result: "dry" }); }
    else {
      const out = await runChild(c);
      for (const t of parseTx(out.text)) { log(`TX deploy · explorer hash ${t.hash ?? "?"} · ledger id ${t.id ?? "?"} · block ${t.block ?? "?"} · ${t.status ?? "?"}`); receipts.push({ label: "deploy", result: "tx", ...t }); }
      if (!existsSync(POT)) throw new Error("deploy did not write the pot file. Check the explorer/indexer for the deploy tx before deploying again (never deploy twice blind).");
    }
  }
  const potFile = fx ? fx.pot : DEPLOY && DRY ? { address: "(new pot)", close: DEPLOY[1], settleBy: DEPLOY[2], claimFrom: DEPLOY[3], stakeRaw: String(BigInt(Math.round(Number(DEPLOY[0]) * 1e6))), phase: "open" } : JSON.parse(readFileSync(POT, "utf8"));
  const src = fx ? fixtureSource(fx) : DEPLOY && DRY ? fixtureSource({ pot: potFile, players: [] }) : await liveSource(potFile.address);
  let S = await src.read();
  log(`pot ${String(S.address).slice(0, 16)}… · phase ${S.phase} · stake ${raw(S.stake)} tNIGHT · entries ${S.entryCount} · revealed ${S.rightCount}`);
  log(`  close ${pt(S.closeMs)} · settleBy ${pt(S.settleByMs)} · claimFrom ${pt(S.claimFromMs)}`);
  const players = (src.kind === "fixture" ? src.players : src.players()).filter((p) => !ONLY || ONLY.includes(p.name));
  for (const p of players) log(`  ticket ${p.name} · pick ${p.racer} · player ${p.id.slice(0, 8)}… · ${S.entered(p.id) ? "entered" : "NOT entered (skipped)"}`);
  const tickets = players.filter((p) => S.entered(p.id));
  if (!players.length) log(`  no local tickets for this pot in ${short(PDIR)}`);

  // 2. entries close (the contract closes them by itself at closeTime; nothing to send)
  await waitUntil(S.closeMs + MARGIN_MS, "entries close; settle needs block time ≥ close");

  // 3 + 4. result → settle or cancel
  S = await src.read();
  if (S.phase === "open") {
    const v = await verdict(S);
    if (v.kind === "winner") {
      const w = racerHex(v.name);
      await step(src, { label: `settle ${v.name}`, c: cmd("settle", v.name), effect: { kind: "settle", winner: w },
        isDone: (s) => { if (s.phase === "open") return false; if (s.phase === "settled" && s.winner === w) return true; throw new Error(`pot is ${s.phase}${s.winner ? " with a different winner" : ""}; stopping`); } });
    } else {
      await step(src, { label: "cancel", c: cmd("cancel"), effect: { kind: "cancel" },
        isDone: (s) => { if (s.phase === "open") return false; if (s.phase === "cancelled") return true; throw new Error("pot is settled, not cancelled; stopping"); } });
    }
  } else log(`judge step already done on chain: phase ${S.phase}`);

  // 5. payouts
  S = await src.read();
  const refundAll = async (why) => { log(`refunds: ${why}`); for (const p of tickets) await step(src, { label: `refund ${p.name}`, c: cmd("refund", p.name), effect: { kind: "refund", id: p.id }, isDone: (s) => s.paid(p.id) }); };
  if (S.phase === "cancelled") await refundAll("pot cancelled; every ticket gets its stake back");
  else if (S.phase === "settled") {
    const mine = tickets.filter((p) => racerHex(p.racer) === S.winner);
    log(`settled · local tickets on the winner: ${mine.map((p) => p.name).join(", ") || "none"}`);
    if (clock.now() < S.claimFromMs - 120_000) for (const p of mine) await step(src, { label: `reveal ${p.name}`, c: cmd("reveal", p.name), effect: { kind: "reveal", id: p.id }, isDone: (s) => s.revealed(p.id) });
    else if (mine.some((p) => !S.revealed(p.id))) log("WARNING: reveal window (until claimFrom) is closed for unrevealed local winners");
    await waitUntil(S.claimFromMs + MARGIN_MS, "claims and refunds open at claimFrom");
    S = await src.read();
    if (S.rightCount > 0) {
      const share = (S.stake * BigInt(S.entryCount)) / BigInt(S.rightCount);
      log(`claims: share = ${S.stake} × ${S.entryCount} ÷ ${S.rightCount} = ${share} raw (${raw(share)} tNIGHT)`);
      for (const p of tickets.filter((p) => S.revealed(p.id))) await step(src, { label: `claim ${p.name}`, c: cmd("claim", p.name), effect: { kind: "claim", id: p.id }, isDone: (s) => s.paid(p.id) });
      const losers = tickets.filter((p) => !S.revealed(p.id)); if (losers.length) log(`no payout (not on the winner): ${losers.map((p) => p.name).join(", ")}`);
    } else await refundAll("nobody revealed the winner; refunds open at claimFrom");
  } else {
    await waitUntil(S.settleByMs + MARGIN_MS, "never settled; refunds open at settleBy");
    await refundAll("never settled");
  }

  // 6. summary
  S = await src.read();
  log(`END · phase ${S.phase} · entries ${S.entryCount} · revealed ${S.rightCount} · local tickets paid ${tickets.filter((p) => S.paid(p.id)).length}/${tickets.length}`);
  for (const r of receipts) log(`  ${r.label.padEnd(22)} ${r.result}${r.hash || r.id ? ` · hash ${r.hash ?? "?"} · id ${r.id ?? "?"} · block ${r.block ?? "?"}` : ""}`);
  log(`run log: ${short(RUNLOG)}`);
}
main().then(() => process.exit(0)).catch((e) => { log(`STOPPED: ${e?.message ?? e}`); for (const r of receipts) log(`  ${r.label.padEnd(22)} ${r.result}`); process.exit(1); });
