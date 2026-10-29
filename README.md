# sworn-escrow

A pot on Midnight that nobody holds the keys to.

Players stake a fixed amount of NIGHT (test NIGHT on preprod) with a sealed pick. The contract itself holds the pot. After the race, a judge posts the winning pick; winners reveal and pull their share. If no result arrives in time, everyone pulls their own stake back. There is no circuit that lets the deployer or the judge move the pot.

**Status:** v0, Midnight **preprod**, test NIGHT only. First full round ran 2026-10-28 (two test players, winner pulled 20 tNIGHT). See [BUILD-LOG.md](BUILD-LOG.md) for every transaction. Not audited. Not for real funds.

![The four moves](https://github.com/Beo-Halfhand/sworn-escrow/raw/main/docs/keyless-pot.png)

## How a round works

1. **Enter** (before close): a player sends the stake and a sealed pick: `commitment = hash(pick, salt)`, stored under the player's id. Nobody can see the pick.
2. **Close**: at `closeTime` (chain time) entries stop.
3. **Result** (between `closeTime` and `settleBy`): the judge key posts the winning pick, once. Or cancels a race that didn't run.
4. **Reveal** (after the result, before `claimFrom`): each winner shows its pick and salt; the contract checks them against the sealed entry.
5. **Claim** (from `claimFrom`): each revealed winner pulls exactly `floor(pot ÷ winners)`, once.
6. **Refund**: if the race was cancelled, the judge never posted by `settleBy`, or no winner revealed by `claimFrom`, every player pulls their own stake back, once.

## Circuits

| Circuit | Who | Rule |
|---|---|---|
| `enter(commitment, payout)` | any player | before `closeTime` · once · takes `stake` NIGHT in |
| `settle(winningPick)` | judge | after `closeTime`, before `settleBy` · once |
| `cancel()` | judge | while open (race cancelled / no eligible winner) |
| `reveal(pick, salt)` | a player | after settle, before `claimFrom` · must match the sealed entry · must be the winning pick |
| `claim(share)` | a revealed winner | from `claimFrom` · `share` must equal floor(pot ÷ winners) exactly · once |
| `refund()` | any player | cancelled, or not settled by `settleBy`, or nobody revealed the winner by `claimFrom` · once |

## What it does not do (v0)
- Stakes and payouts use **unshielded** NIGHT, so amounts and payout addresses are public. Only picks are private, until reveal.
- The **judge is trusted to report the result** (it cannot touch the money). Our judge reads fōmz's official pig race results; its verdict is hashed so anyone can recheck it.
- Rounding dust (less than one unit per winner) stays in the contract.
- One round per deployment.

## Build and test
Compact **0.31.1** (`.compact-version`). Node 22 or 24.
```bash
npm install && npm run compile && npm test
```
11 tests run every circuit in the Compact simulator (no network): a full round, sealed picks, double and late entries, only the judge can settle (not even the deployer), settle windows, cancel refunds, a judge that never posts, nobody revealing, a revealed winner blocking refunds, bad reveals and early claims, and rounding.

## Running a round on preprod

Two ways to submit transactions. The NIGHTGATE path is the one that ran the first round.

**A. Through NIGHTGATE** (fees sponsored by ODATANO's NIGHTGATE; you need your own NIGHTGATE access)
1. Clone a NIGHTGATE notary (we used [maxalexweber1/AGENT_MS](https://github.com/maxalexweber1/AGENT_MS)), set up its `.env` per its README, and copy `scripts/deploy-escrow-nightgate.mjs`, `scripts/escrow-ng.mjs` and `scripts/ng-address.mjs` into its `references/` folder.
2. Compile this repo, then copy `contracts/managed/sworn-escrow` into the notary's `data/zk-ext/` (the contract must load the same compact-runtime as nightgate-tx).
3. Set `SWORN_ESCROW_DIR` to this repo's folder. The judge key, player keys and `deployment.json` are written there; all are gitignored.
4. Deploy: `node references/deploy-escrow-nightgate.mjs <stake> <closeISO> <settleByISO> <claimFromISO>` (`DRY=1` builds without submitting).
5. Get the wallet's address with `node references/ng-address.mjs`, fund it with test NIGHT from the preprod faucet, sync once (`escrow-ng.mjs sync`), and register its NIGHT for DUST once (`escrow-ng.mjs dust`).
6. Play: `escrow-ng.mjs enter <player> <racer>`, then `settle <racer>` (judge), `reveal <player>`, `claim <player>`, or `refund <player>`. `escrow-ng.mjs state` prints the pot's public ledger.

NIGHTGATE currently won't sponsor a call that also moves the caller's own NIGHT, so `enter` and `claim` pay their own fee in DUST from the wallet; the others are sponsored.

**B. Self-funded with midnight-js** (`scripts/escrow.mjs`): reference only. In our tests on 10-28 the node closed every submit from this path; it's kept for when that's resolved.

## Keys
Nothing secret belongs in this repo. Seeds come from your own `.env`; the judge key and player keys are generated locally (mode 600) and ignored by `.gitignore`. Never commit `.players*/`, `.judge-key`, wallet state, or `deployment.json` (it carries NIGHTGATE job and session ids). `deployment.public.json` holds the public fields of the first round.

## Credits
Fee sponsoring and the transaction tooling: **ODATANO's NIGHTGATE** ([@maxalexweber](https://x.com/maxalexweber)). Race results: **fōmz**'s pig race in Midnight City.

## License
MIT
