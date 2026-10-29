#!/usr/bin/env node
/**
 * sworn-escrow deploy through NIGHTGATE (NIGHTGATE sponsors the fee) — 2026-10-28.
 * Runs from the references/ folder of a NIGHTGATE notary clone (github.com/maxalexweber1/AGENT_MS) to reuse its config + helpers. Seeds and keys are never printed.
 * Builds + proves locally from sworn-escrow's own compiled keys (zkConfigDir), sponsor pays the dust.
 *   DRY=1 node references/deploy-escrow-nightgate.mjs <stakeNight> <closeISO> <settleByISO> <claimFromISO>   (builds, stops before the sponsor)
 *         node references/deploy-escrow-nightgate.mjs <stakeNight> <closeISO> <settleByISO> <claimFromISO>
 * First: cp -R $SWORN_ESCROW_DIR/contracts/managed/sworn-escrow data/zk-ext/ (same runtime instance as nightgate-tx).
 * Writes $SWORN_ESCROW_DIR/deployment.json. Judge key: $SWORN_ESCROW_DIR/.judge-key (created 600 if missing).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadDotEnv, log as rawLog } from "../scripts/lib/mc.mjs";
import * as ng from "../scripts/lib/nightgate.mjs";

const R = (s) => String(s).replace(/project_id=[^&\s"']+/g, "project_id=***").replace(/ngat_[A-Za-z0-9_-]+/g, "ngat_***");
const log = (...a) => rawLog(...a.map(R));
loadDotEnv();
const cfg = ng.config();
const DRY = process.env.DRY === "1";
const ESC = process.env.SWORN_ESCROW_DIR ?? path.join(os.homedir(), "workspace", "sworn-escrow");   // this repo's folder (keys + deployment.json live here, gitignored)
// The compiled contract must load the SAME compact-runtime instance as nightgate-tx ("expected instance of
// ContractMaintenanceAuthority" otherwise), so it runs from a copy inside the notary folder: data/zk-ext/sworn-escrow.
const ZK = process.env.ESCROW_ZK ?? path.join(process.cwd(), "data", "zk-ext", "sworn-escrow");
const OUT = path.join(ESC, "deployment.json");
const [stakeNight, close, settleBy, claimFrom] = process.argv.slice(2);
const toSec = (iso) => { const ms = Date.parse(iso); if (!Number.isFinite(ms)) throw new Error(`bad time ${iso}`); return BigInt(Math.floor(ms / 1000)); };
const secretFile = (f) => { if (!fs.existsSync(f)) fs.writeFileSync(f, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" }); return fs.readFileSync(f, "utf8").trim(); };

async function main() {
  if (!cfg.enabled) throw new Error("NIGHTGATE_* not configured");
  if (!claimFrom) throw new Error("usage: <stakeNight> <closeISO> <settleByISO> <claimFromISO>");
  if (!DRY && fs.existsSync(OUT)) throw new Error(`${OUT} already records a pot — move it aside first if you mean to deploy another`);
  const { Contract, pureCircuits } = await import(pathToFileURL(path.join(ZK, "contract", "index.js")).href);
  const { createTxBuilder } = await import("@odatano/nightgate-tx/txbuilder");
  const stake = BigInt(Math.round(Number(stakeNight) * 1e6));
  const judgeId = pureCircuits.playerId(Buffer.from(secretFile(path.join(ESC, ".judge-key")), "hex"));
  const round = new Uint8Array(randomBytes(32));
  const deployerSk = randomBytes(32);
  const witnesses = { secretKey: ({ privateState }) => [privateState, new Uint8Array(deployerSk)] };
  log(`${DRY ? "DRY RUN — " : ""}building sworn-escrow on ${cfg.network} · stake ${stakeNight} tNIGHT · close ${close} · settleBy ${settleBy} · claimFrom ${claimFrom}`);
  const b = await createTxBuilder({
    seedHex: cfg.seedHex, networkId: cfg.network,
    indexerHttpUrl: cfg.indexerHttpUrl, indexerWsUrl: cfg.indexerWsUrl, nodeUrl: cfg.nodeUrl,
    zkConfigDir: ZK, contractClass: Contract, contractName: "sworn-escrow", privateStateId: "sworn-escrow-deployer",
    walletSync: false,
  });
  try {
    const t0 = Date.now();
    const built = await b.buildDeploySponsorable({ bind: false, witnesses, initialPrivateState: {},
      constructorArgs: [round, judgeId, stake, toSec(close), toSec(settleBy), toSec(claimFrom)] });
    log(`deploy built+proved in ${Math.round((Date.now() - t0) / 1000)}s · address ${built.contractAddress} · tx ${Math.round(built.unboundTxB64.length * 0.75 / 1024)} KB`);
    if (DRY) { log("DRY RUN OK — stopped before the sponsor. Nothing sent, nothing spent."); return; }
    const sub = await ng.sponsorUnbound(built.unboundTxB64, `sworn-escrow-deploy-${Date.now()}`, cfg);
    log(`sponsored: job ${sub.jobId}`);
    const rec = { address: built.contractAddress, jobId: sub.jobId, sessionId: sub.sessionId, round: Buffer.from(round).toString("hex"),
      judgeId: Buffer.from(judgeId).toString("hex"), stakeRaw: String(stake), close, settleBy, claimFrom, via: "nightgate", live: false, at: new Date().toISOString() };
    fs.writeFileSync(OUT, JSON.stringify(rec, null, 1) + "\n");
    const job = await ng.waitForJob(sub.jobId, sub.sessionId, { cfg, timeoutMs: 300_000 });
    if (job.status !== "succeeded") throw new Error(`deploy job ended ${job.status}: ${job.errorMessage || job.errorCode || "?"}`);
    fs.writeFileSync(OUT, JSON.stringify({ ...rec, live: true, txHash: job.txHash }, null, 1) + "\n");
    log(`sworn-escrow is LIVE: ${built.contractAddress} (tx ${job.txHash})`);
  } finally { try { await b.close?.(); } catch { /* best effort */ } }
}
main().then(() => process.exit(0)).catch((e) => { log("deploy failed:", e?.message ?? e); process.exit(1); });
