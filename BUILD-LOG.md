# Build log

## 2026-10-28 9:57 AM PT — sworn-escrow v0 LIVE on Midnight preprod
- Address `8109ce1274ecc9feb92b5a8fba0088ced5f61abcbbd3909cd238dfd0c68a69a9` · deploy tx `00503c6cc9914b377fa7734d05be1c956c8eb71049842786129d75fee52ade10be` · sponsored through NIGHTGATE (a deploy grant from ODATANO).
- Round: stake 10 tNIGHT · entries close 12:00 PT · settleBy 12:30 · claimFrom 12:45.
- Path that failed first: self-funded deploy via midnight-js 4.1.1 + wallet-sdk 1.2.0 → every submit closed by the node ("disconnected … 1000 Normal Closure", public + NIGHTGATE node, 4×); in-run retries then failed "could not balance dust" (refused submit leaks the dust note — nightgate-tx README warns of this; withDustGuard). Fix: deploy through NIGHTGATE (scripts/deploy-escrow-nightgate.mjs, run from a NIGHTGATE notary clone's references/ with the compiled contract copied into data/zk-ext so it shares nightgate-tx's compact-runtime instance — else "expected instance of ContractMaintenanceAuthority").
- 11/11 simulator tests; mutation check (3 asserts removed → 2 tests fail).
— Beobrand Halfhand | 2026-10-28

## 2026-10-28 11:28 AM–12:48 PM PT — FIRST FULL ROUND ON PREPROD: stake → settle → reveal → claim
Pot `8109ce12…c68a69a9`. Two test players (both mine: one NIGHTGATE wallet, separate player keys): alice → Nightwire, bob → Halfhand. Result replayed from fōmz's 10-23 official race (Nightwire 4.44, judge verdict 6bf47487…).
- DUST: NIGHTGATE wallet's NIGHT registered for DUST — tx 007dcd56fd88642e93a0f60c50214edb1100737f15e681d90abbea84d57b646fcc (block 3179498), via nightgate-tx submitFinalized (one-shot socket) — first self-funded submit that the node accepted.
- enter alice (self-funded): 00e7c32022f58684de18e5205ae7018f89636a5f39614d172201a76e1ced3cf22a (block 3179566)
- enter bob (self-funded): 005328ae0f883b7b5112e4b613d985702c67bb7d384f5bff875aee77d62276cd72 (block 3179598)
- settle Nightwire (judge, NIGHTGATE-sponsored): 00712cce5848a7c8d2f7200320844e733a3f4f592b49fb45d48695f9582f3c6319
- reveal alice (NIGHTGATE-sponsored): 001a64ad611cc41a810414b017322e64e40e2638c1e2c321684746482cd467a9da
- claim alice 20 tNIGHT (sponsor refused → self-funded): 001ce2a3c009b3d5d7244f04e004576054f1acd19c4c9c3833476cdb6922f7d71d (block 3180302)
- Deadlines enforced on chain: claim at 12:05 → "claims not open yet" (refused at build, nothing spent).
- NIGHTGATE refuses to sponsor calls carrying the caller's unshielded offer ("fallibleUnshieldedOffer alongside its contract calls") → enter + claim self-funded. Max (ODATANO) is looking at allowing it; to test when it lands.
- Bob: no claim (not a winner); no refund (a winner revealed). Loser side enforced by the contract.
— Beobrand Halfhand | 2026-10-28
