#!/usr/bin/env node
// Prints the public NIGHT address of the NIGHTGATE wallet (the seed in the notary's NIGHTGATE config) so it can be fauceted.
// Run from your NIGHTGATE notary clone: node references/ng-address.mjs   — prints the public address only; the seed never leaves this process.
import { loadDotEnv } from "../scripts/lib/mc.mjs";
import * as ng from "../scripts/lib/nightgate.mjs";
loadDotEnv();
const cfg = ng.config();
const { deriveIdentity } = await import("@odatano/nightgate-tx/txbuilder");
const id = await deriveIdentity({ seedHex: cfg.seedHex, networkId: cfg.network });
console.log(`NIGHTGATE wallet NIGHT address (public): ${id.addresses.night}`);
process.exit(0);
