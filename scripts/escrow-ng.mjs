#!/usr/bin/env node
/**
 * sworn-escrow calls through NIGHTGATE (sponsor pays the dust) — 2026-10-28.
 * Runs from the references/ folder of a NIGHTGATE notary clone (github.com/maxalexweber1/AGENT_MS: its .env + helpers),
 * so it shares nightgate-tx's compact-runtime. Contract copy: data/zk-ext/sworn-escrow. Repo folder: $SWORN_ESCROW_DIR.
 * Seed, judge key, player keys and salts are never printed.
 *   node references/escrow-ng.mjs sync                     one-time full wallet sync of the NIGHTGATE wallet (it holds the stake NIGHT); saves state (600)
 *   node references/escrow-ng.mjs state                    public ledger of the pot (deployment.json)
 *   node references/escrow-ng.mjs enter <player> <racer>   seal a pick, pay the stake (needs sync first)
 *   node references/escrow-ng.mjs settle <racer> | cancel  judge
 *   node references/escrow-ng.mjs reveal <player> | claim <player> | refund <player>
 * v0.2 (10-28 11:30): NIGHTGATE won't sponsor a call that moves the caller's own NIGHT ("fallibleUnshieldedOffer
 *   alongside its contract calls"), so value-moving calls (enter, and claim/refund if refused) are SELF-FUNDED: built bound,
 *   dust fee paid from this wallet, submitted with nightgate-tx's submitFinalized (one-shot socket), confirmed with waitLanded,
 *   inside withDustGuard. Needs this wallet's NIGHT registered for DUST once:  node references/escrow-ng.mjs dust
 *   SELF_FUND=1 forces self-funding for any call.
 * Racers are encoded sha256("sworn-escrow:racer:v0:" + lowercase name) — same as scripts/escrow.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadDotEnv, log as rawLog } from "../scripts/lib/mc.mjs";
import * as ng from "../scripts/lib/nightgate.mjs";

const R = (s) => String(s).replace(/project_id=[^&\s"']+/g, "project_id=***").replace(/ngat_[A-Za-z0-9_-]+/g, "ngat_***").replace(/oda_[A-Za-z0-9_-]+/g, "oda_***");
const log = (...a) => rawLog(...a.map(R));
loadDotEnv();
const cfg = ng.config();
const ESC = process.env.SWORN_ESCROW_DIR ?? path.join(os.homedir(), "workspace", "sworn-escrow");   // this repo's folder (keys + deployment.json live here, gitignored)
const ZK = process.env.ESCROW_ZK ?? path.join(process.cwd(), "data", "zk-ext", "sworn-escrow");
const WSTATE = path.join(ESC, ".ng-wallet-state.json"), DEPLOY = path.join(ESC, "deployment.json"), PLAYERS = path.join(ESC, ".players-ng");
const [mode = "state", ...args] = process.argv.slice(2);
const secretFile = (f) => { if (!fs.existsSync(f)) fs.writeFileSync(f, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" }); return fs.readFileSync(f, "utf8").trim(); };
const racer = (n) => new Uint8Array(createHash("sha256").update(`sworn-escrow:racer:v0:${String(n).trim().toLowerCase()}`).digest());
const hex2u8 = (h) => new Uint8Array(Buffer.from(h, "hex"));
const pFile = (n) => path.join(PLAYERS, `${String(n).replace(/[^a-z0-9_-]/gi, "")}.json`);
const fmt = (s) => new Date(Number(s) * 1000).toLocaleString("en-US", { timeZone: "America/Los_Angeles" }) + " PT";
const addr = () => JSON.parse(fs.readFileSync(DEPLOY, "utf8")).address;

const { Contract, ledger, pureCircuits, Phase } = await import(pathToFileURL(path.join(ZK, "contract", "index.js")).href);
const witnesses = { secretKey: ({ privateState }) => [privateState, privateState.sk] };

async function pubState() {
  const { indexerPublicDataProvider } = await import("@midnight-ntwrk/midnight-js-indexer-public-data-provider");
  const cs = await indexerPublicDataProvider(cfg.indexerHttpUrl, cfg.indexerWsUrl).queryContractState(addr());
  if (!cs) throw new Error(`no contract state at ${addr()}`);
  return ledger(cs.data);
}
async function showState() {
  const L = await pubState();
  log(`pot ${addr().slice(0, 16)}… · phase ${Object.keys(Phase).find((k) => Phase[k] === L.phase)} · stake(raw) ${L.stake} · entries ${L.entryCount} · winners revealed ${L.rightCount}`);
  log(`  close ${fmt(L.closeTime)} · settleBy ${fmt(L.settleBy)} · claimFrom ${fmt(L.claimFrom)}`);
}

async function builder(sync) {
  const { createTxBuilder } = await import("@odatano/nightgate-tx/txbuilder");
  const saved = sync && fs.existsSync(WSTATE) ? JSON.parse(fs.readFileSync(WSTATE, "utf8")) : undefined;
  const b = await createTxBuilder({ seedHex: cfg.seedHex, networkId: cfg.network, indexerHttpUrl: cfg.indexerHttpUrl, indexerWsUrl: cfg.indexerWsUrl, nodeUrl: cfg.nodeUrl,
    zkConfigDir: ZK, contractClass: Contract, contractName: "sworn-escrow", privateStateId: "sworn-escrow",
    walletSync: sync ? true : false, ...(saved ? { walletState: saved } : {}) });
  if (sync) {
    log(saved ? "wallet restored from saved state — catching up…" : "no saved state — full sync from genesis (about an hour, once)…");
    const t = setInterval(() => log("… still syncing"), 60_000);
    await b.waitForSync(); clearInterval(t);
    fs.writeFileSync(WSTATE, JSON.stringify(await b.serializeWalletState()), { mode: 0o600 });
    log(`wallet synced · state saved (${path.basename(WSTATE)}, 600)`);
  }
  return b;
}

// The fee wallet: same seed, same derivation as the builder (nightgate-tx example/self-funded.mjs), restored from saved state.
async function feeWallet() {
  const { HDWallet, Roles } = await import("@midnightntwrk/wallet-sdk-hd");
  const { WalletFacade, WalletEntrySchema, mergeWalletEntries } = await import("@midnightntwrk/wallet-sdk-facade");
  const { InMemoryTransactionHistoryStorage } = await import("@midnightntwrk/wallet-sdk-abstractions");
  const { ShieldedWallet } = await import("@midnightntwrk/wallet-sdk-shielded");
  const { UnshieldedWallet, createKeystore, PublicKey } = await import("@midnightntwrk/wallet-sdk-unshielded-wallet");
  const { DustWallet } = await import("@midnightntwrk/wallet-sdk-dust-wallet");
  const { makeWasmProvingService } = await import("@midnightntwrk/wallet-sdk-capabilities/proving");
  const { ZswapSecretKeys, DustSecretKey, LedgerParameters } = await import("@midnight-ntwrk/ledger-v8");
  const hd = HDWallet.fromSeed(new Uint8Array(Buffer.from(cfg.seedHex, "hex")));
  const account = hd.hdWallet.selectAccount(0);
  const roleSeed = (r) => account.selectRole(r).deriveKeyAt(0).key;
  const zswapKeys = ZswapSecretKeys.fromSeed(roleSeed(Roles.Zswap)), dustKey = DustSecretKey.fromSeed(roleSeed(Roles.Dust));
  const keystore = createKeystore(roleSeed(Roles.NightExternal), cfg.network);
  hd.hdWallet.clear();
  const configuration = { networkId: cfg.network, relayURL: new URL(cfg.nodeUrl), provingServerUrl: new URL("http://127.0.0.1:6300"),
    indexerClientConnection: { indexerHttpUrl: cfg.indexerHttpUrl, indexerWsUrl: cfg.indexerWsUrl },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 } };
  const saved = fs.existsSync(WSTATE) ? JSON.parse(fs.readFileSync(WSTATE, "utf8")) : {};
  const facade = await WalletFacade.init({ configuration, provingService: () => makeWasmProvingService({}),
    shielded: () => saved.shielded ? ShieldedWallet(configuration).restore(saved.shielded) : ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
    unshielded: () => saved.unshielded ? UnshieldedWallet(configuration).restore(saved.unshielded) : UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: () => saved.dust ? DustWallet(configuration).restore(saved.dust) : DustWallet(configuration).startWithSecretKey(dustKey, LedgerParameters.initialParameters().dust) });
  await facade.start(zswapKeys, dustKey);
  log("fee wallet: catching up to the chain tip…");
  const st = await facade.waitForSyncedState();
  const save = async () => fs.writeFileSync(WSTATE, JSON.stringify({ shielded: await facade.shielded.serializeState(), unshielded: await facade.unshielded.serializeState(), dust: await facade.dust.serializeState() }), { mode: 0o600 });
  return { facade, configuration, zswapKeys, dustKey, keystore, st, save };
}

async function submitAndConfirm(finalized, label) {
  const tb = await import("@odatano/nightgate-tx/txbuilder");
  const identifier = tb.txIdentifiers(finalized).at(-1);
  log(`${label}: submitting ${identifier.slice(0, 16)}… (one-shot socket)`);
  for (let attempt = 0; ; attempt++) {
    try { await tb.submitFinalized(finalized, { nodeUrl: cfg.nodeUrl }); break; }
    catch (e) {
      if (tb.isAlreadyImported(e)) break;
      const found = await tb.waitLanded(identifier, { indexerHttpUrl: cfg.indexerHttpUrl, timeoutMs: attempt > 0 ? 30_000 : 0 });
      if (found) return found;
      const why = tb.classifyNodeReject ? JSON.stringify(tb.classifyNodeReject(e)) : "";
      if (!tb.isTransportFailure(e) || attempt >= 2) throw new Error(`${label} rejected: ${e?.message ?? e} ${why}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  const landed = await tb.waitLanded(identifier, { indexerHttpUrl: cfg.indexerHttpUrl, timeoutMs: 240_000, pollMs: 6_000 });
  if (!landed) throw new Error(`${label}: not visible on the indexer after 4 min; it may still land`);
  if (!landed.applied) throw new Error(`${label}: landed in block ${landed.height} but NOT applied (${landed.status}) — fee spent, rebuild`);
  log(`${label} LANDED · block ${landed.height} · tx ${identifier}`);
  return landed;
}

async function selfFunded(b, circuitId, args, sk) {
  const tb = await import("@odatano/nightgate-tx/txbuilder");
  const t0 = Date.now();
  const built = await b.buildSponsorable({ contractAddress: addr(), call: { circuitId, args, witnesses }, initialPrivateState: { sk }, bind: true });
  log(`${circuitId} built+proved in ${Math.round((Date.now() - t0) / 1000)}s (bound, ${Math.round(built.serializedBytes / 1024)} KB) — self-funding the fee…`);
  await b.close?.();
  const w = await feeWallet();
  const tx = await tb.deserializeTransaction(built.finalizedTxB64);
  await tb.withDustGuard(w.facade, { configuration: w.configuration, dustKey: w.dustKey }, async () => {
    const recipe = await w.facade.balanceFinalizedTransaction(tx, { shieldedSecretKeys: w.zswapKeys, dustSecretKey: w.dustKey },
      { ttl: new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: ["dust"] });
    const finalized = await w.facade.finalizeRecipe(recipe);
    return submitAndConfirm(finalized, circuitId);
  });
  await w.facade.waitForSyncedState(); await w.save(); await w.facade.stop();
}

// Build, hand to the sponsor, wait for it to land. Unbound first; a call that moves this wallet's NIGHT needs the bound form.
async function send(b, circuitId, args, sk) {
  if (process.env.SELF_FUND === "1" || circuitId === "enter") return selfFunded(b, circuitId, args, sk);
  const call = { circuitId, args, witnesses };
  const t0 = Date.now();
  let built, bound = false;
  try { built = await b.buildSponsorable({ contractAddress: addr(), call, initialPrivateState: { sk }, bind: false }); }
  catch (e) { if (!/balancing transaction/.test(e?.message ?? "")) throw e;
    bound = true; built = await b.buildSponsorable({ contractAddress: addr(), call, initialPrivateState: { sk }, bind: true }); }
  log(`${circuitId} built+proved in ${Math.round((Date.now() - t0) / 1000)}s (${bound ? "bound" : "unbound"}, ${Math.round(built.serializedBytes / 1024)} KB) — sponsoring…`);
  if (!bound) {
    const sub = await ng.sponsorUnbound(built.unboundTxB64, `sworn-escrow-${circuitId}-${Date.now()}`, cfg);
    const job = await ng.waitForJob(sub.jobId, sub.sessionId, { cfg, timeoutMs: 300_000 });
    if (job.status !== "succeeded") throw new Error(`${circuitId} job ended ${job.status}: ${job.errorMessage || job.errorCode || "?"}`);
    log(`${circuitId} LANDED · tx ${job.txHash}`);
  } else {
    const { connect } = await import("@odatano/nightgate-tx");
    const client = connect({ baseUrl: cfg.baseUrl, agentToken: cfg.token });
    const r = await client.sponsorFinalized({ finalizedTxB64: built.finalizedTxB64 });
    if (r?.jobId) { const job = await ng.waitForJob(r.jobId, r.sessionId ?? ng.POOL_SENTINEL, { cfg, timeoutMs: 300_000 });
      if (job.status !== "succeeded") throw new Error(`${circuitId} job ended ${job.status}: ${job.errorMessage || job.errorCode || "?"}`);
      log(`${circuitId} LANDED · tx ${job.txHash}`); }
    else log(`${circuitId} submitted · tx ${r?.txHash ?? JSON.stringify(Object.keys(r ?? {}))}`);
  }
}

async function main() {
  if (!cfg.enabled) throw new Error("NIGHTGATE_* not configured");
  if (mode === "sync") { const b = await builder(true); await b.close?.(); return; }
  if (mode === "state") return showState();
  if (mode === "dust") {   // one time: register this wallet's NIGHT for DUST generation, then wait for spendable DUST
    const w = await feeWallet();
    const bal = (s) => `tNIGHT(raw) ${Object.values(s.unshielded.balances ?? {})[0] ?? 0n} · DUST(raw) ${s.dust.balance(new Date())}`;
    log(`synced · ${bal(w.st)}`);
    const unreg = w.st.unshielded.availableCoins.filter((c) => c.meta?.registeredForDustGeneration !== true);
    if (!unreg.length && w.st.dust.balance(new Date()) > 0n) { log("already registered and DUST is spendable"); await w.save(); await w.facade.stop(); return; }
    if (unreg.length) {
      const { fee } = await w.facade.estimateRegistration(unreg);
      log(`registering ${unreg.length} NIGHT coin(s) for DUST · waiting for them to generate the fee (${fee})…`);
      await w.facade.waitForGeneratedDust(unreg, fee);
      const recipe = await w.facade.registerNightUtxosForDustGeneration(unreg, w.keystore.getPublicKey(), (p) => w.keystore.signData(p));
      await submitAndConfirm(await w.facade.finalizeRecipe(recipe), "dust registration");
    }
    log("waiting for spendable DUST…");
    const { firstValueFrom, filter } = await import("rxjs");
    await firstValueFrom(w.facade.state().pipe(filter((x) => x.isSynced && x.dust.balance(new Date()) > 0n)));
    const s2 = await w.facade.waitForSyncedState(); log(`DUST READY · ${bal(s2)}`);
    await w.save(); await w.facade.stop(); return;
  }
  let b;
  try {
    if (mode === "enter") {
      const [name, pick] = args; if (!pick) throw new Error("usage: enter <player> <racer>");
      fs.mkdirSync(PLAYERS, { recursive: true, mode: 0o700 });
      if (fs.existsSync(pFile(name))) throw new Error(`${name} already has an entry file`);
      if (!fs.existsSync(WSTATE)) throw new Error("run sync first — the stake needs this wallet's NIGHT coins");
      b = await builder(true);
      const { MidnightBech32m, UnshieldedAddress } = await import("@midnightntwrk/wallet-sdk-address-format");
      const payout = { bytes: new Uint8Array(MidnightBech32m.parse(b.addresses.night).decode(UnshieldedAddress, cfg.network).data) };
      const pl = { sk: randomBytes(32).toString("hex"), salt: randomBytes(32).toString("hex"), racer: pick, contract: addr() };
      fs.writeFileSync(pFile(name), JSON.stringify(pl) + "\n", { mode: 0o600 });
      await send(b, "enter", [pureCircuits.commitmentOf(racer(pick), hex2u8(pl.salt)), payout], hex2u8(pl.sk));
      fs.writeFileSync(WSTATE, JSON.stringify(await b.serializeWalletState()), { mode: 0o600 });
    } else if (mode === "settle" || mode === "cancel") {
      if (mode === "settle" && !args[0]) throw new Error("usage: settle <racer>");
      b = await builder(false);
      await send(b, mode, mode === "settle" ? [racer(args[0])] : [], hex2u8(secretFile(path.join(ESC, ".judge-key"))));
    } else if (["reveal", "claim", "refund"].includes(mode)) {
      const pl = JSON.parse(fs.readFileSync(pFile(args[0]), "utf8"));
      b = await builder(false);
      if (mode === "reveal") await send(b, "reveal", [racer(pl.racer), hex2u8(pl.salt)], hex2u8(pl.sk));
      else if (mode === "refund") await send(b, "refund", [], hex2u8(pl.sk));
      else { const L = await pubState(); if (!L.rightCount) throw new Error("no revealed winners — nothing to claim");
        const share = (L.stake * L.entryCount) / L.rightCount; log(`share = ${L.stake} × ${L.entryCount} ÷ ${L.rightCount} = ${share} (raw)`);
        await send(b, "claim", [share], hex2u8(pl.sk)); }
    } else throw new Error(`unknown mode ${mode}`);
  } finally { try { await b?.close?.(); } catch { /* best effort */ } }
  await showState();
}
main().then(() => process.exit(0)).catch((e) => { log("FAILED:", e?.message ?? e); process.exit(1); });
