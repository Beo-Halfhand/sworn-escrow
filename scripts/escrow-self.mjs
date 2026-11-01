// sworn-escrow, SELF-FUNDED path (no NIGHTGATE): this wallet pays its own DUST fees. Vision 2026-11-01.
// A copy of scripts/escrow.mjs (10-28) with the changes it needs to work against the Blockfrost preprod node the way escrow-ng and the
// notary do. escrow.mjs itself is unchanged.
//   1. Endpoints come from the shell or halfhand-notary/.env (NIGHTGATE_NODE_URL / NIGHTGATE_INDEXER_*, see endpoints.mjs) and are never
//      printed. There is no fallback to the public rpc.preprod.midnight.network node.
//   2. One-shot submit: author_submitExtrinsic on a fresh socket, the method nightgate-tx submitFinalized uses. It replaces the wallet SDK's
//      submitAndWatchExtrinsic subscription, which the node closed on every 10-28 deploy ("1000 Normal Closure"). The one-shot submit
//      landed through that same node at 11:27 the same day. SUBMIT=sdk puts back the old path for comparison.
//   3. One try per run. A submit refused before the pool frees its DUST note (wallet.revert) and the run stops. Wallet state is saved
//      only after a sync and after a landed tx, so a retry is a fresh run from clean state. (On 10-28, in-run retries failed with
//      "could not balance dust".)
//   4. A lost socket is never resent. The indexer is probed for the tx identifier for 90 s; if it is still unknown, the run stops.
//      Read state before any retry.
//   5. Each step reads pot state first. Already entered, settled, cancelled, revealed or paid means exit 0 and nothing is sent.
//   6. Every landed tx is logged as one line: TX <step> · hash <64-hex explorer hash> · id <ledger identifier> · block <n> · <status>
//   7. Pot file and players dir are separate from escrow.mjs and escrow-ng:
//        POT_FILE    default deployment.self.json
//        PLAYERS_DIR default .players-self
//      deploy refuses to overwrite any existing file and refuses deployment.json.
//   8. All output goes through mask-stdio.mjs. Library RPC-CORE lines print the node URL with its project_id.
//   9. New modes: endpoints and balance. Both are read-only and send nothing.
// Usage (from ~/workspace/sworn-escrow):
//   node scripts/escrow-self.mjs endpoints        which variable each endpoint comes from (names + host only)
//   node scripts/escrow-self.mjs balance          sync the fee wallet; print tNIGHT + DUST (raw) and DUST registration; send nothing
//   POT_FILE=deployment.self-X.json node scripts/escrow-self.mjs deploy <stakeNight> <closeISO> <settleByISO> <claimFromISO>
//   POT_FILE=deployment.self-X.json node scripts/escrow-self.mjs attach <address>   write POT_FILE from on-chain state (never overwrites; checks the judge)
//   POT_FILE=… node scripts/escrow-self.mjs state [address]
//   POT_FILE=… node scripts/escrow-self.mjs enter <player> <racer> | settle <racer> | cancel | reveal <player> | claim <player> | refund <player>
// Seed: DEPLOY_SEED_FILE (default ../sealed-race/.deploy-seed); wallet state: .wallet-state.json. This is the same wallet escrow.mjs used on
// 10-28, not the NIGHTGATE wallet. Judge key: .judge-key (shared with escrow-ng). Proof server: MIDNIGHT_PROOF_SERVER (default 127.0.0.1:6300).
import './mask-stdio.mjs';
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';
import pino from 'pino';
import { runtimePin } from './pin-runtime.mjs';   // one onchain-runtime-v3 copy; every Midnight module below is loaded AFTER it (dynamic import)
import { InMemoryPrivateStateProvider } from './mem-private-state.mjs';
import { loadEndpoints } from './endpoints.mjs';
const { HDWallet, Roles, WalletFacade, ShieldedWallet, DustWallet, UnshieldedWallet, createKeystore, PublicKey, NoOpTransactionHistoryStorage } = await import('@midnightntwrk/wallet-sdk');
const ledgerV = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
const { unshieldedToken } = ledgerV;
const { setNetworkId, getNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
const { CompiledContract } = await import('@midnight-ntwrk/midnight-js-protocol/compact-js');
const { deployContract, submitCallTx } = await import('@midnight-ntwrk/midnight-js-contracts');
const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
const { MidnightWalletProvider } = await import('@midnight-ntwrk/testkit-js');
const { Contract, ledger, pureCircuits, Phase } = await import('../contracts/managed/sworn-escrow/contract/index.js');

setNetworkId('preprod');
const [mode = 'state', ...args] = process.argv.slice(2);
const t0 = Date.now(); const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const SEED_FILE = process.env.DEPLOY_SEED_FILE ?? '../sealed-race/.deploy-seed';
const STATE_FILE = '.wallet-state.json', ZK = new URL('../contracts/managed/sworn-escrow', import.meta.url).pathname;
const POT_FILE = process.env.POT_FILE ?? 'deployment.self.json';
const PLAYERS = process.env.PLAYERS_DIR ?? '.players-self';
const SUBMIT = process.env.SUBMIT === 'sdk' ? 'sdk' : 'oneshot';
const EP = loadEndpoints();
const secretFile = (f) => { if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); return readFileSync(f, 'utf8').trim(); };
// Private state is IN MEMORY (11-01, as nightgate-tx/escrow-ng): nothing on disk, no password. sworn-escrow keeps no private
// state between calls (each call gets its sk from .judge-key or the ticket file); a deploy's maintenance signing key is not kept.
// The 10:04 deploy failed on the level store's password rule (.ps-password = 64 hex, 2 classes); .ps-password-self is no longer used.
const env = {
  walletNetworkId: 'preprod', networkId: 'preprod',
  indexer: EP.indexer, indexerWS: EP.indexerWS, node: EP.nodeHttp, nodeWS: EP.node,
  proofServer: process.env.MIDNIGHT_PROOF_SERVER ?? 'http://127.0.0.1:6300', faucet: undefined,
};
const witnesses = { secretKey: ({ privateState }) => [privateState, Buffer.from(privateState.sk, 'hex')] };
const compiled = CompiledContract.make('SwornEscrow', Contract).pipe(CompiledContract.withWitnesses(witnesses), CompiledContract.withCompiledFileAssets(ZK));
const toSec = (iso) => { const ms = Date.parse(iso); if (!Number.isFinite(ms)) throw new Error(`bad time ${iso}`); return BigInt(Math.floor(ms / 1000)); };
const fmt = (s) => new Date(Number(s) * 1000).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT';
const hex = (u8) => Buffer.from(u8).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function needEndpoints() {
  if (EP.missing.length) throw new Error(`endpoints missing: ${EP.missing.join(', ')}\n  ${EP.describe().join('\n  ')}`);
  if (EP.publicNode) log('WARNING: node is the public rpc.preprod.midnight.network (the node that closed every SDK submit on 10-28)');
}

// ---------- wallet (as escrow.mjs; state saved after sync, never after a failed submit) ----------
async function openWallet() {
  needEndpoints();
  const hd = HDWallet.fromSeed(Buffer.from(readFileSync(SEED_FILE, 'utf8').trim(), 'hex'));
  if (hd.type !== 'seedOk') throw new Error('invalid seed');
  const k = hd.hdWallet.selectAccount(0).selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust]).deriveKeysAt(0);
  if (k.type !== 'keysDerived') throw new Error('key derivation failed'); hd.hdWallet.clear();
  const zswap = ledgerV.ZswapSecretKeys.fromSeed(k.keys[Roles.Zswap]), dustSk = ledgerV.DustSecretKey.fromSeed(k.keys[Roles.Dust]);
  const ks = createKeystore(k.keys[Roles.NightExternal], getNetworkId());
  const saved = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null;
  const configuration = { networkId: getNetworkId(), indexerClientConnection: { indexerHttpUrl: env.indexer, indexerWsUrl: env.indexerWS },
    provingServerUrl: new URL(env.proofServer), relayURL: new URL(env.nodeWS), txHistoryStorage: new NoOpTransactionHistoryStorage(),
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 } };
  const wallet = await WalletFacade.init({ configuration,
    shielded: (c) => saved ? ShieldedWallet(c).restore(saved.shielded) : ShieldedWallet(c).startWithSecretKeys(zswap),
    unshielded: (c) => saved ? UnshieldedWallet(c).restore(saved.unshielded) : UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(ks)),
    dust: (c) => saved ? DustWallet(c).restore(saved.dust) : DustWallet(c).startWithSecretKey(dustSk, ledgerV.LedgerParameters.initialParameters().dust) });
  await wallet.start(zswap, dustSk);
  for (const line of EP.describe()) log(line);
  log(runtimePin);
  log(saved ? `wallet restored from saved state (${saved.savedAt ?? '?'}) — catching up…` : 'no saved state — full sync from genesis (about an hour the first time)…');
  const prog = (x) => { if (!x || typeof x !== 'object') return '?'; const a = x.appliedIndex ?? x.appliedId, t = x.highestRelevantWalletIndex ?? x.highestTransactionId ?? x.highestIndex; const done = typeof x.isStrictlyComplete === 'function' ? x.isStrictlyComplete() : false; return `${a ?? '?'}/${t ?? '?'}${done ? ' ✓' : ''}`; };
  let last = null; const sub = wallet.state().subscribe({ next: (x) => { last = x; }, error: (e) => log(`state stream error: ${inspect(e, { depth: 6 })}`) });
  const tick = setInterval(() => { if (!last) return log('… connecting (no wallet state yet)');
    log(`… sync shielded ${prog(last.shielded?.state?.progress ?? last.shielded?.progress)} · unshielded ${prog(last.unshielded?.progress)} · dust ${prog(last.dust?.state?.progress ?? last.dust?.progress)} · isSynced ${last.isSynced}`); }, 30000);
  const s = await wallet.waitForSyncedState(); clearInterval(tick); sub.unsubscribe();
  log(`synced · tNIGHT(raw) ${s.unshielded.balances[unshieldedToken().raw] ?? 0n} · DUST(raw) ${s.dust.balance(new Date())}`);
  const save = async () => { writeFileSync(STATE_FILE, JSON.stringify({ savedAt: new Date().toISOString(),
    shielded: await wallet.shielded.serializeState(), unshielded: await wallet.unshielded.serializeState(), dust: await wallet.dust.serializeState() }), { mode: 0o600 });
    log(`wallet state saved (${STATE_FILE}, 600)`); };
  await save();
  return { wallet, zswap, dustSk, ks, save, synced: s };
}

// ---------- submit: one shot, never resent blind ----------
let lastId = null;
async function probeLanded(identifier) {
  const query = `{ transactions(offset:{identifier:"${identifier}"}) { hash block { height } ... on RegularTransaction { identifiers transactionResult { status } } } }`;
  try {
    const r = await fetch(env.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null; const t = (await r.json())?.data?.transactions?.[0];
    if (t?.block?.height == null || t?.transactionResult?.status == null) return null;
    return { hash: t.hash, height: t.block.height, status: t.transactionResult.status };
  } catch { return null; }
}
async function waitLanded(identifier, ms) { const end = Date.now() + ms; for (;;) { const f = await probeLanded(identifier); if (f || Date.now() > end) return f; await sleep(6000); } }

async function encodeExtrinsic(tx) {   // same as nightgate-tx submitFinalized: encode over HTTP (big bodies are fine there), submit over WS
  const { ApiPromise, HttpProvider } = await import('@polkadot/api');
  const api = await ApiPromise.create({ provider: new HttpProvider(env.node), noInitWarn: true });
  try { return api.tx.midnight.sendMnTransaction('0x' + hex(tx.serialize())).toHex(); }
  finally { try { await api.disconnect(); } catch { /* best effort */ } }
}
function submitExtrinsic(extrinsicHex, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(env.nodeWS); let done = false;
    const settle = (fn, v) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch { /* gone */ } fn(v); };
    const lost = (m) => { const e = new Error(m); e.transport = true; settle(reject, e); };
    const timer = setTimeout(() => lost(`no reply in ${timeoutMs / 1000}s`), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'author_submitExtrinsic', params: [extrinsicHex] }));
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m?.id !== 1) return;
      if (m.error) settle(reject, Object.assign(new Error(`node rejected: ${m.error.code} ${m.error.message}${m.error.data !== undefined ? ' | ' + JSON.stringify(m.error.data) : ''}`), { code: m.error.code }));
      else settle(resolve, String(m.result)); };
    ws.onerror = (ev) => lost(`websocket error during submit: ${ev?.message ?? 'connection failed'}`);
    ws.onclose = (ev) => lost(`socket closed before the reply (${ev?.code ?? '?'})`);
  });
}
async function submitOnce(wallet, tx) {
  const id = String(tx.identifiers().at(-1)); lastId = id;
  if (SUBMIT === 'sdk') { log(`submitting ${id} via the wallet SDK (submitAndWatchExtrinsic: the 10-28 path)…`); return wallet.submitTransaction(tx); }
  let xt;
  try { xt = await encodeExtrinsic(tx); }
  catch (e) { try { await wallet.revert(tx); } catch { /* run stops, state not saved */ } throw new Error(`could not encode the extrinsic (nothing sent): ${e?.message ?? e}`); }
  log(`submitting ${id} (one-shot author_submitExtrinsic)…`);
  try { await submitExtrinsic(xt); log('node took it into the pool; waiting for the indexer…'); return id; }
  catch (e) {
    const m = String(e?.message ?? e);
    if (/\b1013\b|already imported/i.test(m)) { log('node: already in the pool (1013), so the first send worked'); return id; }
    if (e?.transport) {
      log(`lost the socket before the reply: ${m}. NOT resending; probing the indexer for ${id.slice(0, 18)}… for 90 s`);
      if (await waitLanded(id, 90000)) { log('it landed'); return id; }
      throw new Error(`submit outcome unknown for ${id}: it may still land. Run "state" before any retry; do not resend.`);
    }
    try { await wallet.revert(tx); log('refused before the pool: DUST note released (wallet.revert); nothing spent'); } catch { log('refused before the pool; DUST release failed (state is not saved this run)'); }
    throw e;
  }
}

async function providers(w) {
  const logger = pino({ level: 'warn' });
  const wp = await MidnightWalletProvider.withWallet(logger, env, w.wallet, w.zswap, w.dustSk, w.ks);
  wp.submitTx = (tx) => submitOnce(w.wallet, tx);
  const pub = indexerPublicDataProvider(env.indexer, env.indexerWS);
  const watch = pub.watchForTxData.bind(pub);
  pub.watchForTxData = (id) => Promise.race([watch(id), sleep(360000).then(() => { throw new Error(`${id} not on the indexer after 6 min: it may still land. Run "state" before any retry.`); })]);
  const zk = new NodeZkConfigProvider(ZK);
  return { wp, p: {
    privateStateProvider: new InMemoryPrivateStateProvider(),
    publicDataProvider: pub, zkConfigProvider: zk, proofProvider: httpClientProofProvider(env.proofServer, zk), walletProvider: wp, midnightProvider: wp } };
}
const txLine = (step, d) => log(`TX ${step} · hash ${d?.txHash ?? '?'} · id ${lastId ?? d?.txId ?? '?'} · block ${d?.blockHeight ?? '?'} · ${d?.status ?? '?'}`);

// ---------- pot ----------
const racer = (name) => new Uint8Array(createHash('sha256').update(`sworn-escrow:racer:v0:${String(name).trim().toLowerCase()}`).digest());
const addrOf = () => { if (!existsSync(POT_FILE)) throw new Error(`no pot file ${POT_FILE} (set POT_FILE)`); return JSON.parse(readFileSync(POT_FILE, 'utf8')).address; };
const playerFile = (n) => `${PLAYERS}/${String(n).replace(/[^a-z0-9_-]/gi, '')}.json`;
const loadPlayer = (n) => { const f = playerFile(n); if (!existsSync(f)) throw new Error(`no player ${n} in ${PLAYERS} — enter first`); return JSON.parse(readFileSync(f, 'utf8')); };
const idOf = (skHex) => pureCircuits.playerId(Buffer.from(skHex, 'hex'));
const phaseName = (L) => Object.keys(Phase).find((k) => Phase[k] === L.phase);

async function pubLedger(addr) {
  needEndpoints();
  const cs = await indexerPublicDataProvider(env.indexer, env.indexerWS).queryContractState(addr);
  if (!cs) throw new Error(`no contract at ${addr}`);
  return ledger(cs.data);
}
async function showState(addr) {
  const L = await pubLedger(addr);
  log(`pot ${addr}\n  phase ${phaseName(L)} · stake(raw) ${L.stake} · entries ${L.entryCount} · winners revealed ${L.rightCount}`
    + `\n  close ${fmt(L.closeTime)} · settleBy ${fmt(L.settleBy)} · claimFrom ${fmt(L.claimFrom)}`);
  return L;
}

async function call(circuitId, who, sk, argsFor) {
  const addr = addrOf(), w = await openWallet(), { p } = await providers(w);
  p.privateStateProvider.setContractAddress(addr);
  await p.privateStateProvider.set(who, { sk });
  const args = typeof argsFor === 'function' ? argsFor(w) : argsFor;
  log(`${circuitId} as ${who} — proving + submitting (one try, ${SUBMIT})…`);
  try {
    const r = await submitCallTx(p, { compiledContract: compiled, contractAddress: addr, circuitId, privateStateId: who, args });
    txLine(circuitId, r.public);
  } catch (e) {
    if (e?.finalizedTxData) { txLine(circuitId, e.finalizedTxData); await w.save(); await w.wallet.stop(); throw new Error(`${circuitId} landed but the call was NOT applied (${e.finalizedTxData.status}): fee spent, pot unchanged`); }
    throw e;   // nothing landed: wallet state not saved; the next run restores the pre-submit state
  }
  await w.save(); await w.wallet.stop(); await showState(addr);
}

// ---------- pot file from chain (attach, and deploy recovery) ----------
async function gql(query) {
  const r = await fetch(env.indexer, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(20000) });
  const j = await r.json(); if (j.errors) throw new Error(`indexer: ${JSON.stringify(j.errors).slice(0, 300)}`); return j.data;
}
async function deployTxOf(address) {
  const d = await gql(`{ contractAction(address:"${address}") { __typename ... on ContractDeploy { transaction { hash block { height } ... on RegularTransaction { identifiers transactionResult { status } } } } } }`);
  const t = d?.contractAction?.transaction; return t ? { hash: t.hash, id: t.identifiers?.at(-1) ?? null, block: t.block?.height, status: t.transactionResult?.status } : null;
}
async function writePotFile(address, how) {
  if (/(^|\/)deployment\.json$/.test(POT_FILE)) throw new Error('POT_FILE=deployment.json is the NIGHTGATE pot file — pick a new name');
  if (existsSync(POT_FILE)) throw new Error(`${POT_FILE} exists — will not overwrite`);
  const L = await pubLedger(address), tx = await deployTxOf(address);
  const judgeId = hex(pureCircuits.playerId(Buffer.from(secretFile('.judge-key'), 'hex')));
  if (hex(L.judge) !== judgeId) throw new Error('this pot\'s judge is NOT our .judge-key: settle/cancel would be refused. Not writing a pot file.');
  const iso = (s) => new Date(Number(s) * 1000).toISOString().replace('.000Z', 'Z');
  writeFileSync(POT_FILE, JSON.stringify({ address, txHash: tx?.hash ?? null, txId: tx?.id ?? lastId ?? null, round: hex(L.round), judgeId,
    stakeRaw: String(L.stake), close: iso(L.closeTime), settleBy: iso(L.settleBy), claimFrom: iso(L.claimFrom), via: 'self', [how]: new Date().toISOString() }, null, 1) + '\n', { flag: 'wx', mode: 0o644 });
  if (tx) log(`TX deploy · hash ${tx.hash} · id ${tx.id ?? '?'} · block ${tx.block} · ${tx.status}`);
  log(`${how === 'attachedAt' ? 'ATTACHED' : 'RECOVERED'} ${address} · judge = our .judge-key ✓ · saved ${POT_FILE}`);
}

// Pre-checks: read the pot first; a step that is already done exits 0 without sending anything.
const done = (msg) => { log(`already done: ${msg}. Nothing sent.`); return true; };
async function preJudge(want) {
  const L = await pubLedger(addrOf()), ph = phaseName(L);
  if (ph === 'open') return false;
  if (want === 'cancel') { if (ph === 'cancelled') return done('pot is cancelled'); throw new Error(`pot is ${ph}, not cancelled — will not cancel`); }
  if (ph === 'settled' && hex(L.winner) === hex(want)) return done('pot is settled with this winner');
  throw new Error(`pot is ${ph}${ph === 'settled' ? ' with a DIFFERENT winner' : ''} — will not settle`);
}
async function prePlayer(pl, step) {
  const L = await pubLedger(addrOf()), me = idOf(pl.sk);
  if (!L.entries.member(me)) { if (step === 'enter') return false; throw new Error('this player has no entry in this pot'); }
  if (step === 'enter') return done('this player is entered');
  if (step === 'reveal' && L.winners.member(me)) return done('this player has revealed');
  if ((step === 'claim' || step === 'refund') && L.paid.member(me)) return done('this player is already paid');
  return false;
}

try {
  if (mode === 'endpoints') { for (const line of EP.describe()) log(line); if (EP.missing.length) { log(`missing: ${EP.missing.join(', ')}`); process.exitCode = 1; } else if (EP.publicNode) log('WARNING: public node'); }
  else if (mode === 'balance') {
    const w = await openWallet();
    const coins = w.synced.unshielded.availableCoins ?? [];
    log(`NIGHT coins ${coins.length} · registered for DUST ${coins.filter((c) => c.meta?.registeredForDustGeneration === true).length}`);
    await w.wallet.stop();
  } else if (mode === 'deploy') {
    const [stakeNight, close, settleBy, claimFrom] = args;
    if (!claimFrom) throw new Error('usage: POT_FILE=deployment.<name>.json deploy <stakeNight> <closeISO> <settleByISO> <claimFromISO>');
    if (/(^|\/)deployment\.json$/.test(POT_FILE)) throw new Error('POT_FILE=deployment.json is the NIGHTGATE pot file — pick a new name');
    if (existsSync(POT_FILE)) throw new Error(`${POT_FILE} exists — pick a new name (deploy never overwrites)`);
    const stake = BigInt(Math.round(Number(stakeNight) * 1e6));   // tNIGHT has 6 decimals
    const judgeSk = secretFile('.judge-key'), judgeId = pureCircuits.playerId(Buffer.from(judgeSk, 'hex'));
    const round = randomBytes(32);
    const w = await openWallet(); const { p } = await providers(w);
    log(`deploying · stake ${stakeNight} tNIGHT · close ${close} · settleBy ${settleBy} · claimFrom ${claimFrom} — proving takes a minute…`);
    let d;
    try {
      d = await deployContract(p, { compiledContract: compiled, privateStateId: 'deployer', initialPrivateState: { sk: randomBytes(32).toString('hex') },
        args: [round, judgeId, stake, toSec(close), toSec(settleBy), toSec(claimFrom)] });
    } catch (e) {   // midnight-js stores private state only AFTER the deploy landed: a failure there must not lose the pot (10-04 PT, 11-01)
      const landed = lastId ? await waitLanded(lastId, 60000) : null;
      const dep = landed ? (await gql(`{ transactions(offset:{identifier:"${lastId}"}) { contractActions { __typename address } } }`))?.transactions?.[0]?.contractActions?.find((a) => a.__typename === 'ContractDeploy') : null;
      if (!dep) throw e;
      log(`deploy LANDED (${landed.status}, block ${landed.height}) but a step after landing failed: ${e?.message ?? e}`);
      await w.save(); await w.wallet.stop();
      await writePotFile(dep.address, 'recoveredAt'); await showState(dep.address);
      throw new Error(`pot is live and ${POT_FILE} was written; only the local post-deploy store failed (deployer private state + maintenance signing key, not needed for any pot step)`);
    }
    const pub = d.deployTxData.public, address = pub.contractAddress;
    txLine('deploy', pub);
    writeFileSync(POT_FILE, JSON.stringify({ address, txHash: pub.txHash ?? null, txId: lastId ?? pub.txId ?? null, round: hex(round), judgeId: hex(judgeId),
      stakeRaw: String(stake), close, settleBy, claimFrom, via: 'self', deployedAt: new Date().toISOString() }, null, 1) + '\n', { flag: 'wx' });
    log(`DEPLOYED ${address} · saved ${POT_FILE}`);
    await w.save(); await w.wallet.stop();
    await showState(address);
  } else if (mode === 'enter') {
    const [name, pick] = args; if (!pick) throw new Error('usage: enter <player> <racer>');
    mkdirSync(PLAYERS, { recursive: true, mode: 0o700 });
    const f = playerFile(name), addr = addrOf();
    let pl;
    if (existsSync(f)) {   // a retry after a failed run reuses the same keys, but only for this pot and only while not entered
      pl = JSON.parse(readFileSync(f, 'utf8'));
      if (pl.contract !== addr) throw new Error(`${name} already has an entry file for another pot`);
      if (pl.racer !== pick) throw new Error(`${name}'s entry file picks a different racer — use that racer or a new player name`);
      log(`${name}: entry file exists for this pot — checking the pot before retrying`);
    } else {
      pl = { sk: randomBytes(32).toString('hex'), salt: randomBytes(32).toString('hex'), racer: pick, contract: addr };
      writeFileSync(f, JSON.stringify(pl) + '\n', { mode: 0o600, flag: 'wx' });
    }
    if (!(await prePlayer(pl, 'enter'))) {
      const commitment = pureCircuits.commitmentOf(racer(pick), Buffer.from(pl.salt, 'hex'));
      await call('enter', `player:${name}`, pl.sk, (w) => [commitment, { bytes: Buffer.from(String(w.ks.getAddress()), 'hex') }]);
    }
  } else if (mode === 'settle') {
    if (!args[0]) throw new Error('usage: settle <racer>');
    if (!(await preJudge(racer(args[0])))) await call('settle', 'judge', secretFile('.judge-key'), [racer(args[0])]);
  } else if (mode === 'cancel') {
    if (!(await preJudge('cancel'))) await call('cancel', 'judge', secretFile('.judge-key'), []);
  } else if (mode === 'reveal') {
    const pl = loadPlayer(args[0]);
    if (!(await prePlayer(pl, 'reveal'))) await call('reveal', `player:${args[0]}`, pl.sk, [racer(pl.racer), Buffer.from(pl.salt, 'hex')]);
  } else if (mode === 'claim') {
    const pl = loadPlayer(args[0]);
    if (!(await prePlayer(pl, 'claim'))) {
      const L = await pubLedger(addrOf()); if (!L.rightCount) throw new Error('no revealed winners — nothing to claim (refund opens at claimFrom)');
      const share = (L.stake * L.entryCount) / L.rightCount; log(`share = ${L.stake} × ${L.entryCount} ÷ ${L.rightCount} = ${share} (raw)`);
      await call('claim', `player:${args[0]}`, pl.sk, [share]);
    }
  } else if (mode === 'refund') {
    const pl = loadPlayer(args[0]);
    if (!(await prePlayer(pl, 'refund'))) await call('refund', `player:${args[0]}`, pl.sk, []);
  } else if (mode === 'attach') {
    if (!/^[0-9a-f]{64}$/.test(args[0] ?? '')) throw new Error('usage: POT_FILE=deployment.<name>.json attach <64-hex contract address>');
    needEndpoints(); await writePotFile(args[0], 'attachedAt'); await showState(args[0]);
  } else if (mode === 'state') {
    await showState(args[0] ?? addrOf());
  } else throw new Error(`unknown mode ${mode}`);
} catch (e) { log(`FAILED: ${e?.message ?? e}\n${inspect(e?.cause ?? e, { depth: 5 }).slice(0, 2000)}`); process.exitCode = 1; }
process.exit();
