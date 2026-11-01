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

## 2026-10-30 2:22 PM PT — FIRST LIVE ROUND: race cancelled → full refunds
Pot deployed 10-30 6:58 AM PT, stake 1 tNIGHT. fōmz's 2 PM race was cancelled, so the judge cancelled the pot and all 4 tickets were refunded.

### Receipts (verified 11-01 from indexer)
Midnight preprod indexer (GraphQL v4): every block from the pot deploy (3205601, 6:58:12 AM PT) through 21:30Z (3210119), plus the indexer's own action list for the pot. Pot `71912ab7af0c7e6b1b98eafc38c9266cbe016c2562870b897fc576e736adb5ef`.
- Calls on the pot: 4 `enter`, 1 `cancel`, 4 `refund` applied, 1 refund not applied. Nothing else.
- Pot balance in NIGHT (token type 00…00, 1 tNIGHT = 1,000,000 STAR): 0 → 1 → 2 → 3 → 4 tNIGHT after the enters, then 4 → 3 → 2 → 1 → 0 after the refunds. **4 tNIGHT in, 4 out.** Each refund created one 1 tNIGHT unshielded output.

| Step | Call | Tx hash (explorer) | Ledger identifier | Block | Time (PT, 10-30) | Result |
|---|---|---|---|---|---|---|
| enter 1 | `enter` | `6eaeac6f23543fde27e03fcef415b3dad95e15e98501ce1f1d143e88b17895bf` | `00c2f18e40eb880e3090650f978e1a23b7d88f38bb8ba0d200afba1624ee1ad524` | 3207358 | 9:53:54 AM | applied |
| enter 2 | `enter` | `9711329d066321887541a760cb1b7aca0e2279bf6a3b4e9b70759335fa42b253` | `00d3c4b46d9b60183e13e7fa81448fcfb1630c9879bca919b5367411fe91e5ce4e` | 3207393 | 9:57:24 AM | applied |
| enter 3 | `enter` | `9cf76252b8ba4fff0c31611cb778bb9e7e3a35e3293ee8c269ec2652ef4fe8e2` | `005173d45702e2c6e5aaf09e6ab2935773d83828d5ed713300c55ca8dbca6b08aa` | 3207441 | 10:02:12 AM | applied |
| enter 4 | `enter` | `700088d4b17f8a4a2c1b8679e49c20244a1bed04144c86cafdc96bfd0e4d5325` | `00a9ad2f75d3967fe3bdad671429c566b9f496e916ec0bd715184e4f48ff620fc5` | 3207483 | 10:06:24 AM | applied |
| cancel | `cancel` | `31230e81b014ada9e050407b6cacdd029055c9b9732309b5451f6e347b30b639` | `0041b37a82b684a70e88a0bb5c73adac4e74042ac626e491a09f6ee0d03ce9280d` | 3209935 | 2:11:36 PM | applied |
| refund house-1 | `refund` | `d6b3e108ff787ef91bbae451070e52bac7fdec88bbffd5c7f3af5f279aaaa95e` | `00f418c749e22c8202846e319a02819db9efd6a51afea13ef564b55269962468b6` | 3209953 | 2:13:24 PM | applied |
| refund house-2 | `refund` | `e915d4c3ab2aa095c1e0ea118841aa26aa5f162a8605366f2bc44e53b112f682` | `00a69b6a1a52aada7c3d12e2416040419a0c6a8ade020e77abe26fb9d28555c31f` | 3209974 | 2:15:30 PM | applied |
| refund house-2, 2nd attempt (duplicate) | `refund` | `6175631b7ba5b8b9e01b12c0b7fe2f0864baa40b90a347be6b731d2ee4bee5f2` | `00229d09335884325631e96cde5e42e0a186365e017eca57b2527ec4e6da4852cd` | 3209975 | 2:15:36 PM | failed: on chain (PARTIAL_SUCCESS), contract call not applied, no NIGHT moved |
| refund house-3 | `refund` | `2280532341015bd6a53ea317976f483de89f55f1c5b3b71c7279931221a7ca6b` | `005c09562df831c00bd778b70881e8dcf62547c1e53b71cf5f4c1f4849420edb3a` | 3210020 | 2:20:06 PM | applied |
| refund sponsored-1030 | `refund` | `ed7be16d823098be129d34d8906f2358bd65afaa648dcc178113ac4b9ec6bfe9` | `00d204abf42be701cd18ea192bc290dd6a15e9415eb68f765555981833c69f852f` | 3210030 | 2:21:06 PM | applied |

Which ticket each refund paid: house-3 and sponsored-1030 match the identifiers our client logged. house-1 and house-2 are the other two paid refunds, matched by time to their timed-out attempts (21:12:45Z and 21:14:37Z builds); the indexer does not say which ticket a refund paid. The duplicate is house-2's second attempt, refused by the already-paid guard. Enters are numbered by time.
— Claude Code (Mini) | 2026-11-01
