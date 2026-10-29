// sworn-escrow on preprod — wallet sync (state saved so later runs take seconds, not an hour), deploy, read state.
//   node scripts/escrow.mjs sync                       full sync once, saves .wallet-state.json (600)
//   node scripts/escrow.mjs deploy <stakeNight> <closeISO> <settleByISO> <claimFromISO>
//   node scripts/escrow.mjs state [address]            public ledger of the deployed pot
//   node scripts/escrow.mjs enter <player> <racer>     a player seals a pick and pays the stake (player key + salt kept in .players/, 600)
//   node scripts/escrow.mjs settle <racer> | cancel    the judge (key in .judge-key)
//   node scripts/escrow.mjs reveal <player> | claim <player> | refund <player>
//   Picks/racers are encoded as sha256("sworn-escrow:racer:v0:" + lowercase name). Payouts go to this wallet's unshielded address.
// Seed: DEPLOY_SEED_FILE (default ../sealed-race/.deploy-seed — the wallet that already holds tNIGHT + DUST).
// Endpoints: MIDNIGHT_INDEXER / MIDNIGHT_INDEXER_WS / MIDNIGHT_NODE_WS / MIDNIGHT_PROOF_SERVER (never printed).
// Keys: .judge-key (judge's secret, 600) and .ps-password (private-state store password, 600) are created here and never printed.
import { WebSocket } from 'ws';
globalThis.WebSocket = WebSocket;
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { inspect } from 'node:util';
import pino from 'pino';
import { HDWallet, Roles, WalletFacade, ShieldedWallet, DustWallet, UnshieldedWallet, createKeystore, PublicKey, NoOpTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk';
import * as ledgerV from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { deployContract, submitCallTx } from '@midnight-ntwrk/midnight-js-contracts';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { MidnightWalletProvider } from '@midnight-ntwrk/testkit-js';
import { Contract, ledger, pureCircuits, Phase } from '../contracts/managed/sworn-escrow/contract/index.js';

setNetworkId('preprod');
const [mode = 'state', ...args] = process.argv.slice(2);
const t0 = Date.now(); const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);
const SEED_FILE = process.env.DEPLOY_SEED_FILE ?? '../sealed-race/.deploy-seed';
const STATE_FILE = '.wallet-state.json', DEPLOY_FILE = 'deployment.json', ZK = new URL('../contracts/managed/sworn-escrow', import.meta.url).pathname;
const secretFile = (f) => { if (!existsSync(f)) writeFileSync(f, randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' }); return readFileSync(f, 'utf8').trim(); };
const env = {
  walletNetworkId: 'preprod', networkId: 'preprod',
  // a NIGHTGATE notary .env names them NIGHTGATE_* (the public preprod indexer fails wallet sync — 10-26); MIDNIGHT_* still wins if set
  indexer: process.env.MIDNIGHT_INDEXER ?? process.env.NIGHTGATE_INDEXER_HTTP_URL ?? 'https://indexer.preprod.midnight.network/api/v4/graphql',
  indexerWS: process.env.MIDNIGHT_INDEXER_WS ?? process.env.NIGHTGATE_INDEXER_WS_URL ?? 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preprod.midnight.network',
  nodeWS: process.env.MIDNIGHT_NODE_WS ?? (/^wss?:/.test(process.env.NIGHTGATE_NODE_URL ?? '') ? process.env.NIGHTGATE_NODE_URL : 'wss://rpc.preprod.midnight.network'),
  proofServer: process.env.MIDNIGHT_PROOF_SERVER ?? 'http://127.0.0.1:6300', faucet: undefined,
};
const witnesses = { secretKey: ({ privateState }) => [privateState, Buffer.from(privateState.sk, 'hex')] };
const compiled = CompiledContract.make('SwornEscrow', Contract).pipe(CompiledContract.withWitnesses(witnesses), CompiledContract.withCompiledFileAssets(ZK));
const toSec = (iso) => { const ms = Date.parse(iso); if (!Number.isFinite(ms)) throw new Error(`bad time ${iso}`); return BigInt(Math.floor(ms / 1000)); };
const fmt = (s) => new Date(Number(s) * 1000).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }) + ' PT';

async function openWallet() {
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
  log(`indexer: ${process.env.MIDNIGHT_INDEXER ? 'MIDNIGHT_INDEXER' : process.env.NIGHTGATE_INDEXER_HTTP_URL ? 'NIGHTGATE_INDEXER_HTTP_URL' : 'public default'} (value not printed)`);
  log(saved ? 'wallet restored from saved state — catching up…' : 'no saved state — full sync from genesis (about an hour the first time)…');
  // progress every 30 s (applied/target per sub-wallet) so a slow sync is visible and a stuck one obvious — same as sealed-race wallet.mjs
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
  return { wallet, zswap, dustSk, ks, save };
}

async function providers(w) {
  const logger = pino({ level: 'warn' });
  const wp = await MidnightWalletProvider.withWallet(logger, env, w.wallet, w.zswap, w.dustSk, w.ks);
  const zk = new NodeZkConfigProvider(ZK);
  return { wp, p: {
    privateStateProvider: levelPrivateStateProvider({ privateStateStoreName: 'sworn-escrow-ps', privateStoragePasswordProvider: async () => secretFile('.ps-password'), accountId: w.ks.getBech32Address().toString() }),
    publicDataProvider: indexerPublicDataProvider(env.indexer, env.indexerWS),
    zkConfigProvider: zk, proofProvider: httpClientProofProvider(env.proofServer, zk), walletProvider: wp, midnightProvider: wp } };
}

const racer = (name) => new Uint8Array(createHash('sha256').update(`sworn-escrow:racer:v0:${String(name).trim().toLowerCase()}`).digest());
const addrOf = () => JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')).address;
const playerFile = (n) => `.players/${String(n).replace(/[^a-z0-9_-]/gi, '')}.json`;
const loadPlayer = (n) => { const f = playerFile(n); if (!existsSync(f)) throw new Error(`no player ${n} — enter first`); return JSON.parse(readFileSync(f, 'utf8')); };
async function call(circuitId, who, sk, args) {
  const addr = addrOf(), w = await openWallet(), { p } = await providers(w);
  p.privateStateProvider.setContractAddress(addr);
  const id = `${who}`; await p.privateStateProvider.set(id, { sk });
  log(`${circuitId} as ${who} — proving + submitting…`);
  const r = await submitCallTx(p, { compiledContract: compiled, contractAddress: addr, circuitId, privateStateId: id, args });
  log(`${circuitId} OK · tx ${r?.public?.txId ?? r?.public?.txHash ?? '?'}`);
  await w.save(); await w.wallet.stop(); await showState(addr); return { w };
}

async function showState(addr) {
  const pub = indexerPublicDataProvider(env.indexer, env.indexerWS);
  const cs = await pub.queryContractState(addr); if (!cs) return log(`no contract at ${addr}`);
  const L = ledger(cs.data);
  log(`pot ${addr}\n  phase ${Object.keys(Phase).find((k) => Phase[k] === L.phase)} · stake(raw) ${L.stake} · entries ${L.entryCount} · winners revealed ${L.rightCount}`
    + `\n  close ${fmt(L.closeTime)} · settleBy ${fmt(L.settleBy)} · claimFrom ${fmt(L.claimFrom)}`);
}

try {
  if (mode === 'sync') { const w = await openWallet(); await w.wallet.stop(); }
  else if (mode === 'deploy') {
    const [stakeNight, close, settleBy, claimFrom] = args;
    if (!claimFrom) throw new Error('usage: deploy <stakeNight> <closeISO> <settleByISO> <claimFromISO>');
    const stake = BigInt(Math.round(Number(stakeNight) * 1e6));   // tNIGHT has 6 decimals (5,000 tNIGHT = 5000000000 raw)
    const judgeSk = secretFile('.judge-key'), judgeId = pureCircuits.playerId(Buffer.from(judgeSk, 'hex'));
    const round = randomBytes(32);
    const w = await openWallet(); const { p } = await providers(w);
    log(`deploying · stake ${stakeNight} tNIGHT · close ${close} · settleBy ${settleBy} · claimFrom ${claimFrom} — proving takes a minute…`);
    // One try per run: a refused submit leaks the dust note in this wallet's memory (nightgate-tx README, withDustGuard),
    //   so an in-run retry fails with "could not balance dust" (seen 10-28). Retry = a fresh run. Deploys now go via NIGHTGATE
    //   (deploy-escrow-nightgate.mjs); this self-funded path is kept for reference.
    const d = await deployContract(p, { compiledContract: compiled, privateStateId: 'deployer', initialPrivateState: { sk: randomBytes(32).toString('hex') },
      args: [round, judgeId, stake, toSec(close), toSec(settleBy), toSec(claimFrom)] });
    const address = d.deployTxData.public.contractAddress;
    writeFileSync(DEPLOY_FILE, JSON.stringify({ address, txId: d.deployTxData.public.txId ?? null, round: Buffer.from(round).toString('hex'),
      judgeId: Buffer.from(judgeId).toString('hex'), stakeRaw: String(stake), close, settleBy, claimFrom, deployedAt: new Date().toISOString() }, null, 1) + '\n');
    log(`DEPLOYED ${address} · saved ${DEPLOY_FILE}`);
    await w.save(); await w.wallet.stop();
    await showState(address);
  } else if (mode === 'enter') {
    const [name, pick] = args; if (!pick) throw new Error('usage: enter <player> <racer>');
    mkdirSync('.players', { recursive: true, mode: 0o700 });
    const f = playerFile(name); if (existsSync(f)) throw new Error(`${name} already has an entry file`);
    const pl = { sk: randomBytes(32).toString('hex'), salt: randomBytes(32).toString('hex'), racer: pick, contract: addrOf() };
    writeFileSync(f, JSON.stringify(pl) + '\n', { mode: 0o600 });
    const commitment = pureCircuits.commitmentOf(racer(pick), Buffer.from(pl.salt, 'hex'));
    const w0 = await openWallet(); const payout = { bytes: Buffer.from(String(w0.ks.getAddress()), 'hex') }; await w0.wallet.stop();
    await call('enter', `player:${name}`, pl.sk, [commitment, payout]);
  } else if (mode === 'settle') {
    if (!args[0]) throw new Error('usage: settle <racer>'); await call('settle', 'judge', secretFile('.judge-key'), [racer(args[0])]);
  } else if (mode === 'cancel') { await call('cancel', 'judge', secretFile('.judge-key'), []);
  } else if (mode === 'reveal') {
    const pl = loadPlayer(args[0]); await call('reveal', `player:${args[0]}`, pl.sk, [racer(pl.racer), Buffer.from(pl.salt, 'hex')]);
  } else if (mode === 'claim') {
    const pl = loadPlayer(args[0]); const cs = await indexerPublicDataProvider(env.indexer, env.indexerWS).queryContractState(addrOf());
    const L = ledger(cs.data); if (!L.rightCount) throw new Error('no revealed winners — nothing to claim (refund opens at claimFrom)');
    const share = (L.stake * L.entryCount) / L.rightCount; log(`share = ${L.stake} × ${L.entryCount} ÷ ${L.rightCount} = ${share} (raw)`);
    await call('claim', `player:${args[0]}`, pl.sk, [share]);
  } else if (mode === 'refund') {
    const pl = loadPlayer(args[0]); await call('refund', `player:${args[0]}`, pl.sk, []);
  } else if (mode === 'state') {
    const addr = args[0] ?? JSON.parse(readFileSync(DEPLOY_FILE, 'utf8')).address; await showState(addr);
  } else throw new Error(`unknown mode ${mode}`);
} catch (e) { log(`FAILED: ${e?.message ?? e}\n${inspect(e?.cause ?? e, { depth: 5 }).slice(0, 2000)}`); process.exitCode = 1; }
process.exit();
