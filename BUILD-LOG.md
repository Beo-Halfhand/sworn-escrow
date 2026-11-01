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

## 2026-11-01: SELF-FUNDED PATH PROVEN
A full round ran on preprod with no NIGHTGATE and no sponsor: `scripts/escrow-self.mjs` signs, proves and pays its own DUST fees, and submits through our own preprod node. Pot `f15bc06d6727871723d45630abd4427ce4884953e547041924e484ec95c87e71`, stake 1 tNIGHT, one test ticket (`self-1`), then cancel and refund.

### What ran
| Step | Time (PT) | Block | Explorer tx hash | Ledger id |
|---|---|---|---|---|
| deploy | 10:04 AM | 3236863 | `193565d156e3630171f82a92bdc01e1f510100a21b323ba2c6ff553060237073` | `00f7344bec85ab2c7a67333a2560ec74a6868580a461c920e6c64ec32858e0829f` |
| enter `self-1` | 10:34 AM | 3237150 | `d399ff0173d945a914523a5a44b9b6083439f256d95d5122eb17030c9c649085` | `0053036e43109f6b46bc4b638a38e8b3fdd4013b9b56bbcdc25816b5ac4da0728c` |
| cancel (judge) | 10:37 AM | 3237175 | `70702d78bb0b9706b9e3aeb7eb4aee23779201e03e980f06ce27e08d45a9d11a` | `00df2a5a86cb2fd27bdbb73348b05d0a425f52c113f6799d2bd9521ed4290102a5` |
| refund `self-1` | 10:40 AM | 3237213 | `871dbc4251a5c98cd8fd380f2c829e4e7673412454a0320de5d6306f4545a02a` | `003dbb2a7923b35b58ce72447330a440dae2502a035eac753502ad9d5aafebc252` |

Times are the run's own log times. The preprod indexer's block times are 10:04:30, 10:33:12, 10:35:42 and 10:39:30 AM PST.
- **Refund again:** `already paid. Nothing sent.` The script read the pot state first and sent nothing.
- **`pot-runner.mjs` dry run** on this pot: `paid 1/1, nothing sent` (`DRY=1` sends nothing).
- **Receipts, checked from the indexer** (`pot-receipts`, read-only): 1 deploy, 1 enter, 1 cancel, 1 refund, all applied. The pot's NIGHT balance went 0 → 1 → 1 → 0. **1 tNIGHT in, 1 out.** The hashes above are the indexer's.

### Two bugs found on the way, and the fixes
1. **Private-state password.** The deploy landed (block 3236863), but the first store of the contract's private state failed: the generated password was 64 hex characters, i.e. two character classes, and midnight-js 4.1.1 wants three or more. Fix: first a password that passes `validatePassword` (`b7a70c6`), then the real fix (`c89a980`): private state is held **in memory** (`scripts/mem-private-state.mjs`, same shape as nightgate-tx's). sworn-escrow keeps no private state between calls, since every call takes its secret from `.judge-key` or the ticket file, so there is no password at all now. `attach <address>` was added, which writes the pot file from on-chain state, and a deploy that landed is kept even if a later step fails.
2. **Two copies of `onchain-runtime-v3`.** This repo's install has 3.1.2 at the top level (used by compact-runtime 0.16.0, which asks for `^3.0.0`) and 3.0.0 nested under midnight-js-protocol 4.1.1 (pinned). midnight-js-contracts wrapped the state with the 3.0.0 copy while the contract's `StateValue` came from 3.1.2, so every circuit call failed with `expected instance of StateValue` (first seen on `enter`; a deploy does not hit it). Fix: `scripts/pin-runtime.mjs`, a module resolve hook that sends every import of `onchain-runtime-v3` to protocol's 3.0.0 copy, which is the layout the NIGHTGATE notary already has. `node_modules` is untouched, and `NO_RUNTIME_PIN=1` turns the pin off to reproduce the bug.

### Why the 10-28 self-funded attempt failed, and this one did not
On 10-28 the self-funded path (`scripts/escrow.mjs`, the midnight-js wallet SDK) submitted with a **subscription**, `author_submitAndWatchExtrinsic`. The node closed that socket with `1000 Normal Closure` on every deploy, and the in-run retries then failed with `could not balance dust`. So the path was written off as "the node closes every submit".
- **The cause was the submit method, not the node.** The same node accepts a **one-shot** `author_submitExtrinsic` on a fresh socket, which is what nightgate-tx's `submitFinalized` uses. It landed a transaction through that node at 11:27 the same day (10-28, per the notes in `escrow-self.mjs`), and it landed all four above.
- **`escrow-self.mjs` therefore:** (1) submits one-shot; (2) makes one try per run, releasing the DUST note if the pool refuses; (3) never resends after a lost socket, but probes the indexer for the tx identifier for 90 s first; (4) reads the pot state before every step, so a step that is already done exits 0 and sends nothing. `SUBMIT=sdk` puts the old path back for comparison.
- Endpoints come from the shell or an env file and are never printed (`scripts/endpoints.mjs`); there is no fallback to the public preprod node. All output goes through `scripts/mask-stdio.mjs`.

### Commits (local at the time of writing)
`51fb328` escrow-self and pot-runner v1 draft · `1fa3360` gitignore for pot files · `b7a70c6` private-state password, attach mode · `c89a980` one runtime copy, in-memory private state.

— Claude Code (Mini) | 2026-11-01

## 2026-11-01 11:27 AM–2:25 PM PT — FIRST AUTOMATED ROUND: pot-runner, self-funded, ran itself
Pot `a5a95bb3b0bee4013b99f90f66d1801cb61d22bb3e744a8af7f41ed473b47031`, stake 1 tNIGHT, self-funded (`scripts/escrow-self.mjs`, no NIGHTGATE). Deadlines: entries close 12:55 PM · settleBy 2:15 PM · claimFrom 2:20 PM PT. Two house tickets: house-a picked fōmz, house-b picked aabou. The judge's source was fōmz's race board.

`scripts/pot-runner.mjs` was started at 11:27 AM with the pot already deployed and both tickets in, and nobody touched it after that. It waited for entries to close, read the board every minute, settled as judge once the 1:00 PM race was on the board, waited for claimFrom, saw that nobody had revealed the winner, refunded both tickets, and stopped.

### What ran
| Step | Time (PT) | Block | Explorer tx hash | Ledger id |
|---|---|---|---|---|
| deploy | 11:15 AM | 3237573 | `300a9b2b7b87aea82a8c678df406b1299c3adde6e5c3fb228cb8daacf0ea7dfd` | `003c8ed1f2e76c28a5995fe310433971c25662e39ea541f27d54b61f1899bbb50b` |
| enter house-a (fōmz) | 11:22 AM | 3237646 | `05b5e2d4bfa701dfbc007064505338814f03127a9eb1f28a4b5d5d57a95046ca` | `0084ed23ef4d1bbdeea36ed0cc3493cf68c1dcc0e35ae2e1775fda21c60f236146` |
| enter house-b (aabou) | 11:25 AM | 3237668 | `4799c6e556a6388b30cfc029b09969ed0e8c76d904c1efeb4349468e94fb3bd9` | `0021df849cfdf31cb3c9367f474c7a31d30f4c69a852a57a06659f8582c3bd6e80` |
| settle kwigbo (judge) | 1:14 PM | 3238761 | `a6e1667f992f8aa90ed4dafcd0e933e5c011442d5caefc6f53e0fbd26e7e93d6` | `0027852f3f06bc58a8beeb4907b16cc3b63a547a1bbbfbb5c2a33bfeb623943958` |
| refund house-a | 2:22 PM | 3239443 | `148c1cee67ea7355b629968e29004dec1507216b67aed49de87e90f1163a2aef` | `00bf95a74983d9148bdd249a30a755d4f20934ea5b7f000faf0932416549e0e3a3` |
| refund house-b | 2:24 PM | 3239464 | `0afb7735489a30fc9ded02b062da41d4976ab7fb9f5e5d8646493a9bc20cc980` | `00a5fbee0bf6c34db457a45b5215432b825fb88af2c610126d06c22c29f5589553` |

- **The race:** gate 1:00 PM PT; kwigbo won with 0.91 (77 racers). The runner first saw it on the board at 1:13 PM and settled at 1:14 PM, an hour before settleBy.
- **Refunds:** neither ticket was on the winner, and nobody revealed kwigbo, so refunds opened at claimFrom (2:20 PM). The runner refunded house-a at 2:22 PM and house-b at 2:24 PM.
- **End:** `END · phase settled · entries 2 · revealed 0 · local tickets paid 2/2`. Every transaction reported `SucceedEntirely`, and the runner read the pot state after each one to confirm it.
- **Receipts, checked from the indexer** (`pot-receipts`, read-only, 3:07 PM): 1 deploy, 2 enter, 1 settle, 2 refund, all applied; no failed calls in the scanned windows. The pot's NIGHT balance went 0 → 1 → 2 → 2 → 1 → 0. **2 tNIGHT in, 2 out.** The hashes and blocks above are the indexer's; the deploy and enters landed before the runner started (11:15–11:25 AM).

— Beobrand Halfhand | 2026-11-01
