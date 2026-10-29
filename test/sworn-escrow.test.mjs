// Local simulator tests for sworn-escrow v0 — no network, no proofs, no real tokens.
// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createConstructorContext, createCircuitContext, sampleContractAddress } from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, pureCircuits, Phase } from '../contracts/managed/sworn-escrow/contract/index.js';

const witnesses = { secretKey: ({ privateState }) => [privateState, privateState.sk] };
const b32 = () => new Uint8Array(randomBytes(32));
const COIN = '00'.repeat(32);
const T0 = 1_900_000_000, CLOSE = T0 + 3600, SETTLE_BY = CLOSE + 3600, CLAIM_FROM = SETTLE_BY + 600;
const X = b32(), Y = b32();   // two racers (hash of agent id, computed off-chain)

function newPot(stake = 10n) {
  const contract = new Contract(witnesses);
  const deployer = { sk: b32() }, judge = { sk: b32() };
  const roundId = b32();
  const init = contract.initialState(createConstructorContext(deployer, COIN), roundId, pureCircuits.playerId(judge.sk), stake, BigInt(CLOSE), BigInt(SETTLE_BY), BigInt(CLAIM_FROM));
  let ctx = createCircuitContext(sampleContractAddress(), COIN, init.currentContractState.data, deployer, undefined, undefined, T0);
  let now = T0;
  const as = (who) => { ctx = { ...ctx, currentPrivateState: who }; };
  const at = (t) => { now = t; };
  const call = (name, ...args) => {
    ctx.currentQueryContext.block = { ...ctx.currentQueryContext.block, secondsSinceEpoch: BigInt(now) };
    const r = contract.impureCircuits[name](ctx, ...args); ctx = r.context; return r;
  };
  const state = () => ledger(ctx.currentQueryContext.state);
  return { deployer, judge, as, at, call, state };
}
const player = (pick) => ({ sk: b32(), pick, salt: b32(), addr: { bytes: b32() } });
const idOf = (p) => pureCircuits.playerId(p.sk);
const enter = (r, p) => { r.as(p); return r.call('enter', pureCircuits.commitmentOf(p.pick, p.salt), p.addr); };
const outs = (res) => [...(res.context.currentQueryContext.effects.unshieldedOutputs?.values?.() ?? [])];
const ins = (res) => [...(res.context.currentQueryContext.effects.unshieldedInputs?.values?.() ?? [])];

test('full round: enter → settle → reveal → claim (winners split the pot)', () => {
  const r = newPot(10n); const a = player(X), b = player(X), c = player(Y);
  const e = enter(r, a); enter(r, b); enter(r, c);
  assert.ok(ins(e).includes(10n), 'enter takes the stake in');
  assert.equal(r.state().entryCount, 3n);
  r.at(CLOSE); r.as(r.judge); r.call('settle', X);
  assert.equal(r.state().phase, Phase.settled);
  r.as(a); r.call('reveal', a.pick, a.salt);
  r.as(b); r.call('reveal', b.pick, b.salt);
  r.as(c); assert.throws(() => r.call('reveal', c.pick, c.salt), /not the winning pick/);
  assert.equal(r.state().rightCount, 2n);
  r.at(CLAIM_FROM);
  r.as(a);
  assert.throws(() => r.call('claim', 16n), /share too large/);
  assert.throws(() => r.call('claim', 14n), /share too small/);
  const pa = r.call('claim', 15n);
  assert.ok(outs(pa).includes(15n), 'claim pays 15 out of the contract');
  assert.throws(() => r.call('claim', 15n), /already paid/);
  r.as(b); r.call('claim', 15n);
  r.as(c); assert.throws(() => r.call('claim', 15n), /not a winner/);
  assert.throws(() => r.call('refund'), /no refund/);
});

test('sealed: only the hash is on chain until reveal', () => {
  const r = newPot(); const a = player(X); enter(r, a);
  assert.notDeepEqual(r.state().entries.lookup(idOf(a)), X);
});

test('rejects: double entry, entry at/after close', () => {
  const r = newPot(); const a = player(X), late = player(X);
  enter(r, a); assert.throws(() => enter(r, a), /already entered/);
  r.at(CLOSE); assert.throws(() => enter(r, late), /entries are closed/);
});

test('nobody but the judge can settle or cancel — not even the deployer', () => {
  const r = newPot(); const a = player(X); enter(r, a); r.at(CLOSE);
  r.as(r.deployer); assert.throws(() => r.call('settle', X), /judge only/); assert.throws(() => r.call('cancel'), /judge only/);
  r.as(a); assert.throws(() => r.call('settle', X), /judge only/);
});

test('rejects: settle before close, settle after settleBy', () => {
  const r = newPot(); const a = player(X); enter(r, a);
  r.as(r.judge); assert.throws(() => r.call('settle', X), /entries still open/);
  r.at(SETTLE_BY); assert.throws(() => r.call('settle', X), /too late to settle/);
});

test('cancel → everyone pulls their own stake back, once', () => {
  const r = newPot(10n); const a = player(X), b = player(Y); enter(r, a); enter(r, b);
  r.as(a); assert.throws(() => r.call('refund'), /no refund/);
  r.as(r.judge); r.call('cancel');
  r.as(a); const ra = r.call('refund'); assert.ok(outs(ra).includes(10n));
  assert.throws(() => r.call('refund'), /already paid/);
  r.as(b); r.call('refund');
  r.as(r.judge); assert.throws(() => r.call('settle', X), /already settled or cancelled/);
});

test('judge never settles → refunds open at settleBy, not before', () => {
  const r = newPot(); const a = player(X); enter(r, a);
  r.at(SETTLE_BY - 1); r.as(a); assert.throws(() => r.call('refund'), /no refund/);
  r.at(SETTLE_BY); r.call('refund');
});

test('nobody reveals the winning pick → refunds at claimFrom, not before', () => {
  const r = newPot(); const a = player(X), b = player(Y); enter(r, a); enter(r, b);
  r.at(CLOSE); r.as(r.judge); r.call('settle', X);
  r.as(a); assert.throws(() => r.call('refund'), /no refund/);
  r.at(CLAIM_FROM); r.call('refund'); r.as(b); r.call('refund');
});

test('a revealed winner blocks refunds for everyone', () => {
  const r = newPot(); const a = player(X), b = player(Y); enter(r, a); enter(r, b);
  r.at(CLOSE); r.as(r.judge); r.call('settle', X); r.as(a); r.call('reveal', a.pick, a.salt);
  r.at(CLAIM_FROM); r.as(b); assert.throws(() => r.call('refund'), /no refund/);
  r.as(a); r.call('claim', 20n);
});

test('rejects: reveal after claimFrom, claim before claimFrom, wrong salt, someone else\'s pick', () => {
  const r = newPot(); const a = player(X), thief = player(Y); enter(r, a); enter(r, thief);
  r.at(CLOSE); r.as(r.judge); r.call('settle', X);
  r.as(a); assert.throws(() => r.call('reveal', a.pick, b32()), /does not match/);
  r.as(thief); assert.throws(() => r.call('reveal', a.pick, a.salt), /does not match/);
  r.as(a); r.call('reveal', a.pick, a.salt); assert.throws(() => r.call('claim', 20n), /claims not open yet/);
  r.at(CLAIM_FROM); r.as(thief); assert.throws(() => r.call('reveal', thief.pick, thief.salt), /reveal window closed/);
});

test('rounding: 4 × 7 = 28 split 3 ways → 9 each, 1 unit of dust stays', () => {
  const r = newPot(7n); const ps = [player(X), player(X), player(X), player(Y)]; ps.forEach((p) => enter(r, p));
  r.at(CLOSE); r.as(r.judge); r.call('settle', X);
  for (const p of ps.slice(0, 3)) { r.as(p); r.call('reveal', p.pick, p.salt); }
  r.at(CLAIM_FROM); for (const p of ps.slice(0, 3)) { r.as(p); r.call('claim', 9n); }
});
