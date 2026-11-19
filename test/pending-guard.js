'use strict';
// The unresolved-payment record in scripts/client-x402.js: a retry after an unserved call must never put a second
// payment on the chain for the same call unless the caller says so. Offline: a fake seller and a fake node.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolve, join } = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const N = require('nanocurrency');

const exec = promisify(execFile);
const root = resolve(__dirname, '..');
const client = resolve(root, 'scripts/client-x402.js');
const PAY_TO = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
const REP = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const hex64 = () => randomBytes(32).toString('hex').toUpperCase();

async function readBody(req) { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c).toString('utf8'); }
async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  t.after(async () => { server.closeAllConnections?.(); await new Promise(ok => server.close(() => ok())); });
  return 'http://127.0.0.1:' + server.address().port;
}

// One world per test: a seller that answers 402 and then does what `seller.mode` says with the paid request, and a node
// (reachable as a node RPC and as the no-node API on the seller's origin) whose chain the test moves by hand.
async function world(t) {
  const seed = randomBytes(32).toString('hex');
  const account = N.deriveAddress(N.derivePublicKey(N.deriveSecretKey(seed, 0)), { useNanoPrefix: true });
  const first = hex64();
  const node = { frontier: first, chain: new Map([[first, { confirmed: true, successor: null }]]), lookup: 'ok' };
  const seller = { mode: 'drop', paid: [], amount: '1000000000000000000000000000', onPaid: null };
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'pk-pending-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const blockInfo = hash => {
    if (node.lookup === 'error') return { error: 'Too many requests' };
    if (node.lookup === 'account-not-found') return { error: 'Account not found' };
    const b = node.chain.get(String(hash).toUpperCase());
    return b ? { block_account: account, confirmed: b.confirmed ? 'true' : 'false', successor: b.successor || '0'.repeat(64) } : { error: 'Block not found' };
  };
  const rpc = await listen(t, async (req, res) => {
    const q = JSON.parse(await readBody(req));
    res.setHeader('content-type', 'application/json');
    if (q.action === 'account_info') return res.end(JSON.stringify({ frontier: node.frontier, representative: REP, balance: '5000000000000000000000000000000' }));
    res.end(JSON.stringify(q.action === 'block_info' ? blockInfo(q.hash) : { error: 'unknown action' }));
  });
  const origin = await listen(t, async (req, res) => {
    await readBody(req);
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/v1/account_info') return res.end(JSON.stringify({ found: true, frontier: node.frontier, representative: REP, balance_raw: '5000000000000000000000000000000' }));
    if (u.pathname === '/v1/verify') {
      const b = blockInfo(u.searchParams.get('hash'));
      if (b.error === 'Block not found') { res.statusCode = 404; return res.end(JSON.stringify({ found: false })); }
      if (b.error) { res.statusCode = 502; return res.end(JSON.stringify({ error: b.error })); }
      return res.end(JSON.stringify({ found: true, confirmed: b.confirmed === 'true', successor: /^0+$/.test(b.successor) ? null : b.successor }));
    }
    const sig = req.headers['payment-signature'];
    if (!sig) {
      const pr = { x402Version: 2, resource: { url: 'http://x/' }, accepts: [{ scheme: 'exact', network: 'nano:mainnet', asset: 'XNO', amount: seller.amount, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { workOptional: true } }] };
      res.writeHead(402, { 'payment-required': Buffer.from(JSON.stringify(pr)).toString('base64') });
      return res.end('{}');
    }
    const block = JSON.parse(Buffer.from(sig, 'base64').toString('utf8')).payload.block;
    seller.paid.push({ hash: N.hashBlock(block), previous: block.previous.toUpperCase(), method: req.method });
    if (seller.onPaid) seller.onPaid(seller.paid[seller.paid.length - 1]);
    if (seller.mode === 'drop') return req.socket.destroy();
    if (seller.mode === 'refuse') { res.statusCode = 500; return res.end('{"error":"upstream"}'); }
    res.end('{"ok":true}');
  });
  const run = async (pathAndQuery = '/thing', env = {}, base = origin) => {
    try {
      const r = await exec(process.execPath, [client, base + pathAndQuery], {
        cwd: root, timeout: 10000, maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, NANO_SEED: seed, NANO_RPC: rpc, NANO_MAX_PAY: '1', NANO_LOCK_DIR: dir, NANO_PENDING_DIR: dir, ...env },
      });
      return { code: 0, stdout: r.stdout, stderr: r.stderr };
    } catch (e) { if (e.killed) throw e; return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' }; }
  };
  const record = () => { try { return JSON.parse(fs.readFileSync(join(dir, 'pending-' + account + '.json'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const unserved = () => { try { return fs.readFileSync(join(dir, 'unserved-' + account + '.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } };
  // someone broadcasts a block the seller was given: it becomes the confirmed successor of its predecessor
  const land = b => { node.chain.get(b.previous).successor = b.hash; node.chain.set(b.hash, { confirmed: true, successor: null }); node.frontier = b.hash; };
  // another block lands on the current frontier (a receive, another wallet's send)
  const moveOn = (confirmed = true) => land({ hash: hex64(), previous: node.frontier }) || (node.chain.get(node.frontier).confirmed = confirmed);
  return { account, origin, node, seller, dir, run, record, unserved, land, moveOn };
}

test('a served call leaves no record', async t => {
  const w = await world(t); w.seller.mode = 'serve';
  const r = await w.run();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.record(), null);
  assert.equal(w.seller.paid.length, 1);
});

test('the record is on disk when the signed request reaches the seller, and carries nothing spendable', async t => {
  const w = await world(t);
  let atArrival;
  w.seller.onPaid = () => { atArrival = w.record(); };
  const r = await w.run();
  assert.equal(r.code, 1, r.stderr);
  assert.equal(atArrival.length, 1, 'written before the request was sent');
  assert.equal(atArrival[0].hash, w.seller.paid[0].hash);
  const rec = w.record();
  assert.equal(rec[0].previous, w.seller.paid[0].previous);
  assert.deepEqual(Object.keys(rec[0]).sort(), ['amount_raw', 'body_sha256', 'hash', 'method', 'pay_to', 'previous', 'signed_at', 'signed_url', 'url']);
  assert.doesNotMatch(JSON.stringify(rec), /signature|"work"/);
  assert.equal(fs.statSync(join(w.dir, 'pending-' + w.account + '.json')).mode & 0o777, 0o600);
  assert.match(r.stderr, /unresolved payment [0-9A-F]{64} recorded in /);
});

test('lost reply, the block landed: the same call is refused with exit 7 and no second block is signed', async t => {
  const w = await world(t);
  await w.run();
  w.land(w.seller.paid[0]);
  const r = await w.run();
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stderr, /this call was already paid/);
  assert.match(r.stderr, new RegExp('NANO_PENDING_ACK=' + w.seller.paid[0].hash));
  assert.doesNotMatch(r.stderr, /signed block/);
  assert.equal(w.seller.paid.length, 1, 'no second payment reached the seller');
  assert.equal(w.record().length, 1, 'the entry stays');
});

test('the same call spelled another way is still the same call', async t => {
  const w = await world(t);
  await w.run('/thing', { METHOD: 'post', BODY: '{"n":1}' });
  w.land(w.seller.paid[0]);
  for (const [path, env, base] of [['/thing#frag', { METHOD: 'POST', BODY: '{"n":1}' }], ['/thing', { METHOD: 'Post', BODY: '{"n":1}' }, w.origin.replace('http://', 'HTTP://')]]) {
    const r = await w.run(path, env, base);
    assert.equal(r.code, 7, path + ' ' + r.stderr);
  }
  assert.equal(w.seller.paid.length, 1);
});

test('lost reply, the block landed behind a later block: still refused', async t => {
  const w = await world(t);
  await w.run();
  w.land(w.seller.paid[0]); w.moveOn();
  const r = await w.run();
  assert.equal(r.code, 7, r.stderr);
  assert.equal(w.seller.paid.length, 1);
});

test('NANO_PENDING_ACK with the block hash pays again on purpose and moves the entry to the unserved list', async t => {
  const w = await world(t);
  await w.run();
  const first = w.seller.paid[0].hash;
  w.land(w.seller.paid[0]); w.seller.mode = 'serve';
  const wrong = await w.run('/thing', { NANO_PENDING_ACK: hex64() });
  assert.equal(wrong.code, 7, 'another hash acknowledges nothing');
  const r = await w.run('/thing', { NANO_PENDING_ACK: hex64() + ', ' + first.toLowerCase() });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.seller.paid.length, 2);
  assert.equal(w.seller.paid[1].previous, first, 'the second payment is built on the first');
  assert.equal(w.record(), null);
  const u = w.unserved();
  assert.equal(u.length, 1); assert.equal(u[0].hash, first); assert.equal(u[0].acknowledged, true); assert.equal(u[0].fate, 'landed');
});

test('a different call in between does not unlock the paid one', async t => {
  const w = await world(t);
  await w.run('/thing?q=1');
  w.land(w.seller.paid[0]); w.seller.mode = 'serve';
  const other = await w.run('/thing?q=2');
  assert.equal(other.code, 0, other.stderr);
  assert.match(other.stderr, /it stays on record/);
  assert.equal(w.record().length, 1, 'the landed entry is still there');
  const again = await w.run('/thing?q=1');
  assert.equal(again.code, 7, again.stderr);
  assert.equal(w.seller.paid.length, 2, 'q=1 was paid once, q=2 once');
});

test('after the hold a landed entry is history and the call can be bought again', async t => {
  const w = await world(t);
  await w.run();
  w.land(w.seller.paid[0]); w.seller.mode = 'serve';
  const r = await w.run('/thing', { NANO_PENDING_HOLD_H: '0.0000001' });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.record(), null);
  assert.equal(w.unserved()[0].acknowledged, false);
});

test('the account moved on and the node cannot say: the same call is refused, another call goes ahead, nothing is dropped', async t => {
  for (const mode of ['error', 'account-not-found']) {
    const w = await world(t);
    await w.run('/thing?q=1');
    w.moveOn(); w.node.lookup = mode;
    const r = await w.run('/thing?q=1');
    assert.equal(r.code, 7, mode + ' ' + r.stderr);
    assert.match(r.stderr, /may already be paid/);
    assert.doesNotMatch(r.stderr, /signed block/);
    w.seller.mode = 'serve';
    const other = await w.run('/thing?q=2');
    assert.equal(other.code, 0, mode + ' ' + other.stderr);
    assert.equal(w.record().length, 1, 'the unknown entry stays');
    w.node.lookup = 'ok';   // now the node shows the predecessor's other, confirmed successor: proven dead
    const again = await w.run('/thing?q=1');
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stderr, /can never land/);
    assert.equal(w.record(), null);
  }
});

test('"Block not found" from a node that is behind is not proof of death', async t => {
  const w = await world(t);
  const start = w.node.frontier;
  w.moveOn(); await w.run();   // B1 signed on the second block
  const b1 = w.seller.paid[0];
  // the next answers come from a node that has only the first block: older frontier, B1 and its predecessor unknown
  const fresh = w.node.chain; w.node.chain = new Map([[start, { confirmed: true, successor: null }]]); w.node.frontier = start;
  const stale = await w.run();
  assert.equal(stale.code, 7, stale.stderr);
  assert.equal(w.record().length, 1, 'not dropped');
  w.node.chain = fresh; w.land(b1);   // the node catches up and B1 is on the chain
  const r = await w.run();
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stderr, /already paid/);
  assert.equal(w.seller.paid.length, 1);
});

test('an unconfirmed other successor is not proof of death either', async t => {
  const w = await world(t);
  await w.run();
  w.moveOn(false);
  const r = await w.run();
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stderr, /may already be paid/);
});

test('never broadcast: the next block names the same predecessor, so the two cannot both land', async t => {
  const w = await world(t);
  await w.run();
  const same = await w.run();   // same quote on the same frontier: the identical block, one entry
  assert.equal(same.code, 1, same.stderr);
  assert.match(same.stderr, /names the same predecessor/);
  assert.equal(w.seller.paid[1].hash, w.seller.paid[0].hash);
  assert.equal(w.record().length, 1, 'one entry per block');
  w.seller.amount = '2000000000000000000000000000';   // a new price: a different block on the same predecessor
  await w.run();
  assert.notEqual(w.seller.paid[2].hash, w.seller.paid[0].hash);
  assert.equal(w.seller.paid[2].previous, w.seller.paid[0].previous);
  assert.deepEqual(w.record().map(p => p.hash), [w.seller.paid[0].hash, w.seller.paid[2].hash], 'both blocks are on record');
});

test('an older un-broadcast block that lands later still blocks the same call (the list is not one entry deep)', async t => {
  const w = await world(t);
  await w.run();
  w.seller.amount = '2000000000000000000000000000';
  await w.run();   // B1 and B2, different blocks on one predecessor, neither served
  assert.notEqual(w.seller.paid[0].hash, w.seller.paid[1].hash);
  w.land(w.seller.paid[0]);   // the seller broadcasts B1 late
  const r = await w.run();
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stderr, new RegExp('Block ' + w.seller.paid[0].hash));
  assert.match(r.stderr, new RegExp(w.seller.paid[1].hash + '[^\\n]*can never land'));
  assert.equal(w.seller.paid.length, 2, 'no third block');
  assert.deepEqual(w.record().map(p => p.hash), [w.seller.paid[0].hash], 'B2 is proven dead and dropped even though the run refused');
});

test('the same URL with another body or method is another call', async t => {
  const w = await world(t);
  await w.run('/thing', { METHOD: 'POST', BODY: '{"n":1}' });
  w.land(w.seller.paid[0]);
  const same = await w.run('/thing', { METHOD: 'POST', BODY: '{"n":1}' });
  assert.equal(same.code, 7, same.stderr);
  w.seller.mode = 'serve';
  const body = await w.run('/thing', { METHOD: 'POST', BODY: '{"n":2}' });
  assert.equal(body.code, 0, body.stderr);
  const method = await w.run('/thing', { METHOD: 'PUT', BODY: '{"n":1}' });
  assert.equal(method.code, 0, method.stderr);
});

test('a refusal while another block takes the predecessor drops the entry in the same run', async t => {
  const w = await world(t); w.seller.mode = 'refuse';
  w.seller.onPaid = () => w.moveOn();   // the account moves while the seller holds the block
  const r = await w.run();
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stderr, /can never land/);
  assert.equal(w.record(), null);
});

test('without NANO_RPC the same readings come from the API (/v1/account_info, /v1/verify with successor)', async t => {
  const w = await world(t);
  const env = { NANO_RPC: '', API: w.origin };
  await w.run('/thing', env);
  w.land(w.seller.paid[0]); w.moveOn();
  const paid = await w.run('/thing', env);
  assert.equal(paid.code, 7, paid.stderr);
  assert.match(paid.stderr, /already paid/);
  const v = await world(t);
  await v.run('/thing', { NANO_RPC: '', API: v.origin });
  v.moveOn(); v.seller.mode = 'serve';
  const dead = await v.run('/thing', { NANO_RPC: '', API: v.origin });
  assert.equal(dead.code, 0, dead.stderr);
  assert.match(dead.stderr, /can never land/);
});

test('two processes that do not share the wallet lock both end up on record', async t => {
  const w = await world(t);
  await Promise.all([w.run('/thing?q=1', { NANO_LOCK: '0' }), w.run('/thing?q=2', { NANO_LOCK: '0' }), w.run('/thing?q=3', { NANO_LOCK: '0' })]);
  w.seller.amount = '2000000000000000000000000000';
  await Promise.all([w.run('/thing?q=4', { NANO_LOCK: '0' }), w.run('/thing?q=5', { NANO_LOCK: '0' })]);
  assert.deepEqual(new Set(w.record().map(p => p.url.slice(-3))), new Set(['q=1', 'q=2', 'q=3', 'q=4', 'q=5']));
});

test('a record that cannot be written stops the payment before it is sent', async t => {
  const w = await world(t);
  const ro = join(w.dir, 'read-only'); fs.mkdirSync(ro, { mode: 0o500 });
  t.after(() => { try { fs.chmodSync(ro, 0o700); } catch { /* already removed with the test directory */ } });
  const r = await w.run('/thing', { NANO_PENDING_DIR: ro });
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stderr, /signed block/);
  assert.match(r.stderr, /cannot be written.*was not sent and is discarded/);
  assert.doesNotMatch(r.stderr, /Nothing signed/);
  assert.equal(w.seller.paid.length, 0, 'the signed request never left the process');
});

test('a record directory that cannot be read stops the payment before anything is signed', async t => {
  const w = await world(t);
  const file = join(w.dir, 'a-file'); fs.writeFileSync(file, 'x');
  const r = await w.run('/thing', { NANO_PENDING_DIR: join(file, 'sub') });
  assert.equal(r.code, 7, r.stderr);
  assert.match(r.stderr, /cannot be read/);
  assert.doesNotMatch(r.stderr, /signed block/);
  assert.equal(w.seller.paid.length, 0);
});

test('a record that cannot be parsed is not overwritten: exit 7', async t => {
  const w = await world(t);
  const file = join(w.dir, 'pending-' + w.account + '.json');
  fs.writeFileSync(file, '{"half":');
  const r = await w.run();
  assert.equal(r.code, 7, r.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"half":');
  assert.equal(w.seller.paid.length, 0);
});

test('NANO_PENDING=0 turns the record off (the old behaviour)', async t => {
  const w = await world(t);
  await w.run('/thing', { NANO_PENDING: '0' });
  assert.equal(w.record(), null);
  w.land(w.seller.paid[0]);
  const r = await w.run('/thing', { NANO_PENDING: '0' });
  assert.equal(r.code, 1);
  assert.equal(w.seller.paid.length, 2, 'without the record the retry pays twice');
});
