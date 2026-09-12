#!/usr/bin/env node
// Hold and spend Nano from a seed with no node and no API key, using only the free
// endpoints on pursekeeper.dev (account_info, receivable, work, process, verify).
//
//   NANO_SEED=<64 hex> node no-node.js address              print the account address
//   NANO_SEED=<64 hex> node no-node.js status               balance, frontier, unpocketed sends
//   NANO_SEED=<64 hex> node no-node.js receive              pocket every confirmed send (opens the account if new)
//   NANO_SEED=<64 hex> node no-node.js send <nano_...> <amount in XNO, e.g. 0.001>
//
// Env: NANO_SEED (required), NANO_INDEX (default 0), NANO_REP (representative for a new
// account; default: a well-known public one), API (default https://pursekeeper.dev).
// Only dependency: npm i nanocurrency. Free calls are limited to 60 per minute per IP
// (work: 6 per minute per IP, GPU, about a second; pay 0.001 XNO per work with X-Nano-Payment or x402 for no limit).
'use strict';
const N = require('nanocurrency');
const API = (process.env.API || 'https://pursekeeper.dev').replace(/\/$/, '');
const REP = process.env.NANO_REP || 'nano_3arg3asgtigae3xckabaaewkx3bzsh7nwz7jkmjos79ihyaxwphhm6qgjps4';
const RAW = 10n ** 30n;
const get = p => fetch(API + p).then(r => r.json());
const post = (p, body) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const toRaw = s => { const m = /^(\d+)(?:\.(\d{1,30}))?$/.exec(s); if (!m) throw new Error('amount must be a decimal XNO amount'); return BigInt(m[1]) * RAW + BigInt((m[2] || '').padEnd(30, '0')); };
const fmt = r => { r = BigInt(r); const w = r / RAW, f = (r % RAW).toString().padStart(30, '0').replace(/0+$/, ''); return w + (f ? '.' + f : ''); };

async function work(hash) {
  for (let i = 0; i < 20; i++) {
    const r = await post('/v1/work', { hash });
    if (r.work) return r.work;
    if (r.error && /limit/i.test(r.error)) { await new Promise(s => setTimeout(s, 20000)); continue; }
    throw new Error('work: ' + JSON.stringify(r));
  }
  throw new Error('work: gave up');
}
async function broadcast(block, subtype) {
  const r = await post('/v1/process', { block, subtype });
  if (!r.ok) throw new Error('process: ' + JSON.stringify(r));
  return r.hash;
}

(async () => {
  if (!process.env.NANO_SEED) { console.error('set NANO_SEED (64 hex chars)'); process.exit(2); }
  const sk = N.deriveSecretKey(process.env.NANO_SEED, Number(process.env.NANO_INDEX || 0));
  const pub = N.derivePublicKey(sk);
  const account = N.deriveAddress(pub, { useNanoPrefix: true });
  const cmd = process.argv[2] || 'status';
  if (cmd === 'address') return console.log(account);

  const info = await get('/v1/account_info?account=' + account);
  if (info.error) throw new Error('account_info: ' + info.error);
  const pend = await get('/v1/receivable?account=' + account);
  if (cmd === 'status') return console.log(JSON.stringify({ account, open: info.found, balance_nano: info.balance_nano, frontier: info.frontier, representative: info.representative, unpocketed: pend.blocks }, null, 1));

  let previous = info.found ? info.frontier : '0'.repeat(64);
  let balance = BigInt(info.balance_raw || '0');
  let rep = info.representative || REP;

  // If the chain moved under us (a concurrent receive changed the frontier between
  // account_info and process), the node answers with a balance/previous error. Refetch
  // and retry once or twice instead of failing the whole command (finding F2 of the
  // 2026-09-10 review at /examples/review-2026-09-10-llmrt-no-node.md).
  const STALE = /previous|balance|fork|gap/i;
  async function refresh() {
    const i = await get('/v1/account_info?account=' + account);
    if (i.error) throw new Error('account_info: ' + i.error);
    previous = i.found ? i.frontier : '0'.repeat(64);
    balance = BigInt(i.balance_raw || '0');
    rep = i.representative || REP;
  }
  async function publish(build, subtype) {
    for (let attempt = 0; ; attempt++) {
      const block = build();
      block.work = await work(previous === '0'.repeat(64) ? pub : previous);   // open blocks: work on the account public key
      block.signature = N.signBlock({ hash: N.hashBlock(block), secretKey: sk });
      try { return await broadcast(block, subtype); }
      catch (e) {
        if (attempt >= 2 || !STALE.test(String(e.message))) throw e;
        console.error('frontier moved (' + e.message.slice(0, 80) + '); refetching and retrying');
        await refresh();
      }
    }
  }

  if (cmd === 'receive') {
    if (!pend.blocks.length) return console.error('nothing to receive');
    if (pend.blocks.length > 6) console.error(pend.blocks.length + ' pending sends need ' + pend.blocks.length + ' work calls; about ' + Math.ceil(pend.blocks.length / 6) + ' min at the free rate of 6/min (pay per work to skip the wait)');
    for (const b of pend.blocks) {
      // Skip a send that a concurrent receive already pocketed (seen after a retry).
      const still = await get('/v1/receivable?account=' + account);
      if (!still.blocks.some(x => x.hash === b.hash)) { console.error('already received ' + b.hash.slice(0, 8) + ', skipping'); continue; }
      const open = () => previous === '0'.repeat(64);
      const hash = await publish(() => ({ type: 'state', account, previous, representative: rep, balance: (balance + BigInt(b.amount_raw)).toString(), link: b.hash, work: null }), open() ? 'open' : 'receive');
      balance += BigInt(b.amount_raw);
      console.log((open() ? 'open ' : 'receive ') + fmt(b.amount_raw) + ' from ' + b.from + ' -> ' + hash);
      previous = hash;
    }
    return;
  }

  if (cmd === 'send') {
    const to = process.argv[3], amount = toRaw(process.argv[4] || '');
    if (!to || !process.argv[4]) throw new Error('usage: send <nano_ address> <amount>');
    if (!N.checkAddress(to)) throw new Error('invalid address (bad prefix or checksum): ' + to);
    if (!info.found) throw new Error('account has no blocks; receive first');
    if (amount > balance) throw new Error('balance ' + fmt(balance) + ' XNO is below ' + fmt(amount));
    const hash = await publish(() => {
      if (amount > balance) throw new Error('balance changed to ' + fmt(balance) + ' XNO, below ' + fmt(amount));
      return { type: 'state', account, previous, representative: rep, balance: (balance - amount).toString(), link: N.derivePublicKey(to), work: null };
    }, 'send');
    console.log('send ' + fmt(amount) + ' to ' + to + ' -> ' + hash + '  (confirm: ' + API + '/v1/verify?hash=' + hash + ')');
    return;
  }
  throw new Error('unknown command ' + cmd);
})().catch(e => { console.error(e.message || e); process.exit(1); });
