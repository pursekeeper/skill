#!/usr/bin/env node
// x402 client for Nano (scheme "exact", network "nano:mainnet"), usable against
// https://pursekeeper.dev or any other seller that speaks the same scheme.
//
//   NANO_SEED=<64 hex> node client-x402.js [url]      (default: pursekeeper.dev/v1/echo?msg=hello)
//
// Env: NANO_SEED (required), NANO_INDEX (account index, default 0),
//      NANO_RPC (node RPC for account_info, default http://127.0.0.1:7076),
//      WORK_URL (optional RPC-style work_generate endpoint),
//      METHOD and BODY (optional, e.g. METHOD=POST BODY='{"hash":"..."}' to buy a work
//      from POST /v1/work; the same method and body are used for the 402 probe and the paid call).
// Work: WORK_URL if set, else the seller's POST /v1/work if it has one, else local
// CPU (about 20-30 s). Only dependency: nanocurrency (npm i nanocurrency).
//
// Flow: GET url -> 402 with PAYMENT-REQUIRED (base64 JSON, x402 v2) -> pick the
// nano:mainnet "exact" entry -> build and sign a send block for exactly that amount
// -> retry with PAYMENT-SIGNATURE: base64 JSON {x402Version, resource, accepted,
// payload: {block}} -> the seller verifies and broadcasts the block, replies 200
// with PAYMENT-RESPONSE carrying the block hash.
'use strict';
const N = require('nanocurrency');

const url = process.argv[2] || 'https://pursekeeper.dev/v1/echo?msg=hello';
const RPC = process.env.NANO_RPC || 'http://127.0.0.1:7076';
const b64 = s => Buffer.from(JSON.stringify(s)).toString('base64');
const unb64 = s => JSON.parse(Buffer.from(s, 'base64').toString('utf8'));
const rpc = (u, body) => fetch(u, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }).then(r => r.json());

async function work(hash, origin) {
  if (process.env.WORK_URL) {
    const r = await rpc(process.env.WORK_URL, { action: 'work_generate', hash, difficulty: 'fffffff800000000' });
    if (r.work) return r.work;
    console.error('WORK_URL failed:', r.error || r);
  }
  try {
    const r = await fetch(origin + '/v1/work', { method: 'POST', body: JSON.stringify({ hash }), headers: { 'content-type': 'application/json' } });
    const j = await r.json();
    if (j.work) return j.work;
    console.error('seller /v1/work:', r.status, j.error || j);
  } catch (e) { console.error('seller /v1/work unavailable:', e.message); }
  console.error('computing work locally (this takes a while)...');
  return N.computeWork(hash, { workThreshold: 'fffffff800000000' });
}

(async () => {
  if (!process.env.NANO_SEED) { console.error('set NANO_SEED (64 hex chars)'); process.exit(2); }
  const sk = N.deriveSecretKey(process.env.NANO_SEED, Number(process.env.NANO_INDEX || 0));
  const account = N.deriveAddress(N.derivePublicKey(sk), { useNanoPrefix: true });
  console.error('paying from', account);

  const reqInit = () => ({ method: process.env.METHOD || 'GET', body: process.env.BODY, headers: process.env.BODY ? { 'content-type': 'application/json' } : {} });
  const first = await fetch(url, reqInit());
  if (first.status !== 402) { console.log(first.status, await first.text()); return; }
  const hdr = first.headers.get('payment-required');
  const pr = hdr ? unb64(hdr) : (await first.json()).x402;
  if (!pr || pr.x402Version !== 2) throw new Error('no x402 v2 PaymentRequired in the 402');
  const accepted = pr.accepts.find(a => a.scheme === 'exact' && a.network === 'nano:mainnet');
  if (!accepted) throw new Error('seller does not accept exact on nano:mainnet: ' + JSON.stringify(pr.accepts));
  console.error(`seller wants ${accepted.amount} raw (${Number(accepted.amount) / 1e30} NANO) to ${accepted.payTo}`);

  const info = await rpc(RPC, { action: 'account_info', account, representative: 'true' });
  if (info.error) throw new Error('account_info: ' + info.error + ' (is the account opened and funded?)');
  const balance = BigInt(info.balance) - BigInt(accepted.amount);
  if (balance < 0n) throw new Error(`insufficient balance: have ${info.balance} raw`);

  // Sellers that advertise extra.work = 'optional' compute the work themselves (work is not
  // signed, so the seller can add it): send "0" and skip the wait. Set FORCE_WORK=1 to opt out.
  const sellerWork = accepted.extra && accepted.extra.work === 'optional' && !process.env.FORCE_WORK;
  const w = sellerWork ? '0' : await work(info.frontier, new URL(url).origin);
  if (sellerWork) console.error('seller computes the work; skipping work_generate');
  const { block, hash } = N.createBlock(sk, { work: w, previous: info.frontier, representative: info.representative, balance: balance.toString(), link: accepted.payTo });
  block.account = block.account.replace(/^xrb_/, 'nano_');
  console.error('signed block', hash);

  const payload = { x402Version: 2, resource: pr.resource, accepted, payload: { block } };
  const init = reqInit(); init.headers['PAYMENT-SIGNATURE'] = b64(payload);
  const r = await fetch(url, init);
  const settle = r.headers.get('payment-response');
  if (settle) console.error('settlement:', unb64(settle));
  console.log(r.status, await r.text());
})().catch(e => { console.error('error:', e.message); process.exit(1); });
