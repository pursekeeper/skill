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
  // `unreceivable` is a guard only: the node checks previous-is-frontier before it checks the
  // source (ledger.cpp, V28.2), so a send pocketed by a concurrent receive answers Fork, not
  // Unreceivable; Ops Control HQ raised the case 2026-09-27 and it is matched anyway.
  const STALE = /previous|balance|fork|gap|unreceivable/i;
  async function refresh() {
    const i = await get('/v1/account_info?account=' + account);
    if (i.error) throw new Error('account_info: ' + i.error);
    previous = i.found ? i.frontier : '0'.repeat(64);
    balance = BigInt(i.balance_raw || '0');
    rep = i.representative || REP;
  }
  // subtype may be a function of the built block: a retry after refresh() can turn an
  // open (previous all zero) into a receive when another process opened the account
  // meanwhile, and the node checks the subtype it is given (Ops Control HQ, 2026-09-27).
  // stillValid, if given, is re-checked after every refresh; when it answers false the
  // retry's precondition is gone (the send was pocketed by a concurrent receive) and
  // publish returns null instead of broadcasting a block that cannot be valid.
  // A "frontier moved" answer can mean the block just sent was accepted and only the reply was lost
  // (timeout, 5xx, dropped connection): the node moved the frontier to it. Rebuilding at the new
  // frontier would then broadcast a second block, and a send would pay twice (pyfile-toolkit,
  // pursekeeper/skill#3, 2026-09-28). So the retry first asks the node whether the block landed.
  // Three answers: true (it is the frontier, or /v1/verify found it), false (/v1/verify positively
  // says not found), or a thrown error when it cannot tell (/v1/verify unreachable, rate-limited,
  // or answering without a found field). The first version returned false in that last case, which
  // rebuilt and could pay twice exactly when the API was flaky and a receive had moved the frontier
  // meanwhile (Ops Control HQ, 2026-09-28, later-fix on 8fe3ac7). Not knowing is not "did not land".
  async function landed(hash) {
    if (previous === hash) return true;   // refresh() already ran: the frontier is the block itself
    let v;
    try { v = await get('/v1/verify?hash=' + hash); }
    catch (e) { throw new Error('cannot tell whether ' + hash + ' landed (/v1/verify unreachable: ' + e.message + '); nothing rebuilt, nothing resent; check the account history and run the command again'); }
    if (v && v.found === true) return true;
    if (v && v.found === false) return false;
    throw new Error('cannot tell whether ' + hash + ' landed (/v1/verify answered ' + JSON.stringify(v).slice(0, 160) + '); nothing rebuilt, nothing resent; check the account history and run the command again');
  }
  async function publish(build, subtype, stillValid) {
    for (let attempt = 0; ; attempt++) {
      const block = build();
      const st = typeof subtype === 'function' ? subtype(block) : subtype;
      block.work = await work(block.previous === '0'.repeat(64) ? pub : block.previous);   // open blocks: work on the account public key
      const hash = N.hashBlock(block);
      block.signature = N.signBlock({ hash, secretKey: sk });
      try { const h = await broadcast(block, st); previous = h; balance = BigInt(block.balance); return h; }
      catch (e) {
        // Every failure after the signed block was handed to /v1/process is indeterminate, not only a stale-frontier
        // answer: a timeout, a 5xx or a dropped connection ("fetch failed") can follow a node that accepted the block.
        // Until 0.1.7 those were rethrown before landed(), and a rerun of `send` paid twice (Ops Control HQ and
        // Enrico, 2026-09-28). So: ask the chain first, and only then decide between retry and failure.
        const msg = String(e.message);
        console.error('process failed (' + msg.slice(0, 80) + '); checking whether the block landed');
        await refresh();
        if (await landed(hash)) { console.error('it did: ' + hash.slice(0, 8) + ' is on the chain; not resending'); previous = hash; balance = BigInt(block.balance); return hash; }
        if (attempt >= 2 || !STALE.test(msg)) { console.error('it did not (' + hash.slice(0, 8) + ' is not on the chain); nothing resent'); throw e; }
        console.error('it did not; refetching and retrying');
        if (stillValid && !(await stillValid())) return null;
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
      let kind;
      const hash = await publish(
        () => ({ type: 'state', account, previous, representative: rep, balance: (balance + BigInt(b.amount_raw)).toString(), link: b.hash, work: null }),
        blk => (kind = blk.previous === '0'.repeat(64) ? 'open' : 'receive'),
        async () => (await get('/v1/receivable?account=' + account)).blocks.some(x => x.hash === b.hash));
      if (!hash) { console.error('already received ' + b.hash.slice(0, 8) + ' during the retry, skipping'); continue; }
      console.log(kind + ' ' + fmt(b.amount_raw) + ' from ' + b.from + ' -> ' + hash);
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
    console.log('send ' + fmt(amount) + ' to ' + to + ' -> ' + hash + '  (confirm: ' + API + '/v1/verify?hash=' + hash + ')');   // publish() already moved previous/balance to the new frontier
    return;
  }
  throw new Error('unknown command ' + cmd);
})().catch(e => { console.error(e.message || e); process.exit(1); });
