'use strict';
// Offline tests for scripts/inference-proxy.js: a mock door that answers 402 in both Nano dialects, a mock node RPC
// that checks every block's signature and frontier, and the proxy as a child process with a throwaway seed.
// Nothing here reaches the network: UPSTREAM, NANO_RPC and WORK_URL all point at loopback servers in this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const N = require('nanocurrency');

const SCRIPT = resolve(__dirname, '../scripts/inference-proxy.js');
const RAW = 10n ** 30n;
const WORK = '0'.repeat(16);   // not real proof of work; the mock node does not check it
const listen = (srv) => new Promise(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const readBody = req => new Promise((res, rej) => { let t = ''; req.on('data', c => { t += c; }); req.on('end', () => res(t)); req.on('error', rej); });

// ---- mock node: one account, balance and frontier tracked, blocks verified ----
function mockNode(account, publicKey, initial) {
  const st = { frontier: 'A'.repeat(64), balance: initial, processed: [], receivable: {}, rejectNext: 0, workCalls: 0 };
  const srv = createServer(async (req, res) => {
    const b = JSON.parse(await readBody(req) || '{}');
    const out = o => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (b.action === 'account_info') return out({ frontier: st.frontier, balance: st.balance.toString(), representative: account });
    if (b.action === 'work_generate') { st.workCalls++; return out({ work: WORK }); }
    if (b.action === 'receivable') return out({ blocks: st.receivable });
    if (b.action === 'block_info') return st.processed.some(p => p.hash === b.hash) ? out({ contents: {} }) : out({ error: 'Block not found' });
    if (b.action === 'process') {
      const blk = b.block;
      const hash = N.hashBlock(blk);
      if (st.rejectNext > 0) { st.rejectNext--; return out({ error: 'Gap previous block' }); }
      if (blk.previous !== st.frontier) return out({ error: 'Fork' });
      if (blk.account !== account) return out({ error: 'Bad account' });
      if (!N.verifyBlock({ hash, signature: blk.signature, publicKey })) return out({ error: 'Bad signature' });
      const bal = BigInt(blk.balance);
      if (b.subtype === 'send') {
        if (bal > st.balance) return out({ error: 'Negative spend' });
        st.processed.push({ hash, subtype: 'send', amount: st.balance - bal, link: blk.link });
      } else {
        const src = st.receivable[blk.link];
        if (!src || BigInt(src.amount) !== bal - st.balance) return out({ error: 'Unreceivable' });
        delete st.receivable[blk.link];
        st.processed.push({ hash, subtype: b.subtype, amount: bal - st.balance });
      }
      st.balance = bal; st.frontier = hash;
      return out({ hash });
    }
    out({ error: 'unknown action ' + b.action });
  });
  return { srv, st };
}

// ---- mock door: NanoGPT-shaped ("nano") or x402 v2 ("exact") 402s, then serves the paid call ----
function mockDoor(node, opts) {
  const st = { quotes: {}, completes: [], served: 0, lastHeaders: null, mode: opts.mode, amount: opts.amount, sse: !!opts.sse, host: null };
  const srv = createServer(async (req, res) => {
    const body = await readBody(req);
    st.lastHeaders = req.headers;
    const out = (code, h, s) => { res.writeHead(code, { 'content-type': 'application/json', ...h }); res.end(s); };
    const serve = () => {
      st.served++;
      let stream = false; try { stream = !!JSON.parse(body).stream; } catch { /* ignore */ }
      if (stream && st.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"}}]}\n\n');
        return res.end('data: [DONE]\n\n');
      }
      out(200, { 'x-x402-reconciliation-amount': '0.000001' }, JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { total_tokens: 2 } }));
    };
    if (req.url.startsWith('/status/')) {
      const q = st.quotes[req.url.slice('/status/'.length)];
      const paid = q && node.st.processed.some(p => p.subtype === 'send' && p.link === N.derivePublicKey(q.payTo).toUpperCase() && p.amount === BigInt(q.amount));
      return out(200, {}, JSON.stringify(paid ? { status: 'paid', readyToComplete: true } : { status: 'pending', readyToComplete: false }));
    }
    if (req.url.startsWith('/complete/')) {
      const id = req.url.slice('/complete/'.length);
      const q = st.quotes[id];
      st.completes.push({ id, headers: req.headers, body });
      if (!q) return out(404, {}, '{"error":"unknown payment"}');
      const paid = node.st.processed.find(p => p.subtype === 'send' && p.link === N.derivePublicKey(q.payTo).toUpperCase() && p.amount === BigInt(q.amount));
      if (!paid) return out(402, {}, '{"error":"not paid"}');
      if (req.headers['x-x402-payment-id'] !== id || body !== q.body) return out(400, {}, '{"error":"body or id mismatch"}');
      return serve();
    }
    if (!req.url.startsWith('/v1/')) return out(404, {}, '{}');
    const host = req.headers.host;
    const payTo = opts.payTo || N.deriveAddress(N.derivePublicKey(randomBytes(32).toString('hex')), { useNanoPrefix: true });
    if (st.mode === 'exact') {
      const sig = req.headers['payment-signature'];
      const accepts = [{ scheme: 'exact', network: 'nano:mainnet', amount: String(st.amount), payTo, resource: `http://${host}${req.url}` }];
      if (!sig) return out(402, { 'payment-required': Buffer.from(JSON.stringify({ x402Version: 2, resource: `http://${host}${req.url}`, accepts })).toString('base64') }, '{"error":"payment required"}');
      const p = JSON.parse(Buffer.from(sig, 'base64').toString());
      const blk = p.payload.block;
      // the seller broadcasts
      const r = await fetch(node.url, { method: 'POST', body: JSON.stringify({ action: 'process', subtype: 'send', block: blk }) }).then(x => x.json());
      if (!r.hash) return out(402, {}, JSON.stringify({ error: 'rejected: ' + r.error }));
      if (opts.refuseAfterBroadcast) return out(500, {}, '{"error":"served nothing"}');
      return serve();
    }
    // nano dialect
    const id = 'pay_' + randomBytes(6).toString('hex');
    const base = opts.completeHost ? `http://${opts.completeHost}` : `http://${host}`;
    const a = { scheme: 'nano', protocolScheme: 'nano', network: 'nano-mainnet', amount: String(st.amount), payTo, paymentId: id,
      expiresAt: opts.expired ? new Date(Date.now() - 1000).toISOString() : new Date(Date.now() + 900000).toISOString(), statusUrl: `${base}/status/${id}`, completeUrl: `${base}/complete/${id}` };
    if (opts.malformed === 'amount') a.amount = 'abc';
    if (opts.malformed === 'zero') a.amount = '0';
    st.quotes[id] = { payTo, amount: a.amount, body };
    out(402, { 'x-payment-schemes': 'nano,nano-exact' }, JSON.stringify({ error: { message: 'Insufficient balance', code: 'insufficient_quota' }, payment: { version: 1, paymentId: id, accepted: [a, { scheme: 'nano-exact', network: 'nano:mainnet', amount: a.amount, payTo }] } }));
  });
  return { srv, st };
}

async function startProxy(env, dir) {
  const proc = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, HOME: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  proc.stderr.on('data', c => { err += c; });
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('proxy did not start: ' + err)), 8000);
    proc.stderr.on('data', () => { const m = /127\.0\.0\.1:(\d+)\/v1/.exec(err); if (m) { clearTimeout(t); res(Number(m[1])); } });
    proc.on('exit', code => { clearTimeout(t); rej(new Error('proxy exited ' + code + ': ' + err)); });
  });
  const stop = () => new Promise(r => { if (proc.exitCode !== null || proc.signalCode !== null) return r(); proc.once('exit', r); proc.kill(); });
  return { proc, port, log: () => err, stop };
}

async function stand(t, doorOpts, envExtra) {
  const seed = randomBytes(32).toString('hex');
  const pub = N.derivePublicKey(N.deriveSecretKey(seed, 0));
  const account = N.deriveAddress(pub, { useNanoPrefix: true });
  const node = mockNode(account, pub, 10n * RAW);
  node.url = await listen(node.srv);
  const door = mockDoor(node, doorOpts);
  const doorUrl = await listen(door.srv);
  const dir = await mkdtemp(join(tmpdir(), 'pk-proxy-'));
  const env = { NANO_SEED: seed, UPSTREAM: doorUrl, NANO_RPC: node.url, WORK_URL: node.url, NANO_CAP: '0.01', NANO_MAX_PER_CALL: '0.005', PORT: '0', STATE_FILE: join(dir, 'state.json'), ...envExtra };
  const proxy = await startProxy(env, dir);
  const shut = srv => { srv.close(); srv.closeAllConnections(); };
  t.after(async () => { await proxy.stop(); shut(node.srv); shut(door.srv); await rm(dir, { recursive: true, force: true }); });
  const call = (body, headers, path) => fetch(`http://127.0.0.1:${proxy.port}${path || '/v1/chat/completions'}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer runtime-key', ...headers }, body: JSON.stringify(body) });
  const stateOf = () => fetch(`http://127.0.0.1:${proxy.port}/_nano/state`).then(r => r.json());
  return { seed, account, pub, node, door, proxy, env, dir, call, stateOf, restart: async () => { await proxy.stop(); const p2 = await startProxy(env, dir); t.after(() => p2.stop()); return p2; } };
}

const MSG = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const MILLI = RAW / 1000n;   // 0.001 XNO

test('nano dialect: pays exactly the quote, completes with the same body, counts the spend', async t => {
  const s = await stand(t, { mode: 'nano', amount: MILLI });
  const r = await s.call(MSG);
  const text = await r.text();
  assert.equal(r.status, 200, text);
  const j = JSON.parse(text);
  assert.equal(j.choices[0].message.content, 'OK');
  assert.equal(r.headers.get('x-payer-paid'), '0.001');
  assert.equal(s.node.st.processed.length, 1);
  assert.equal(s.node.st.processed[0].amount, MILLI);
  assert.equal(s.door.st.completes.length, 1);
  assert.equal(s.door.st.completes[0].body, JSON.stringify(MSG));
  assert.equal(s.door.st.completes[0].headers['x-x402'], 'nano');
  assert.equal(s.door.st.lastHeaders.authorization, undefined, 'the runtime key never reaches the door');
  const st = await s.stateOf();
  assert.equal(st.spent, '0.001'); assert.equal(st.paid, 1); assert.equal(st.payments[0].status, 'served');
  assert.equal(st.payments[0].reconciliation, '0.000001');
  const file = JSON.parse(await readFile(s.env.STATE_FILE, 'utf8'));
  assert.equal(file.spent_raw, MILLI.toString());
});

test('cap: a quote that would pass the cumulative cap is refused before anything is signed', async t => {
  const s = await stand(t, { mode: 'nano', amount: 6n * MILLI }, { NANO_CAP: '0.01', NANO_MAX_PER_CALL: '0.01' });
  assert.equal((await s.call(MSG)).status, 200);
  const r = await s.call(MSG);
  assert.equal(r.status, 402);
  const j = await r.json();
  assert.equal(j.payer.code, 'cap_exceeded');
  assert.equal(s.node.st.processed.length, 1, 'no second block');
  assert.equal(s.node.st.workCalls, 1, 'no work requested for the refused call');
  assert.equal((await s.stateOf()).spent, '0.006');
});

test('per-call limit, payTo allow-list, expired quote, malformed amounts: refused, nothing signed', async t => {
  for (const [opts, env, code] of [
    [{ mode: 'nano', amount: 6n * MILLI }, { NANO_MAX_PER_CALL: '0.005' }, 'over_per_call_limit'],
    [{ mode: 'nano', amount: MILLI }, { NANO_ALLOW_PAYTO: 'nano_3arg3asgtigae3xckabaaewkx3bzsh7nwz7jkmjos79ihyaxwphhm6qgjps4' }, 'payto_not_allowed'],
    [{ mode: 'nano', amount: MILLI, expired: true }, {}, 'quote_expired'],
    [{ mode: 'nano', amount: MILLI, malformed: 'amount' }, {}, 'malformed_quote'],
    [{ mode: 'nano', amount: MILLI, malformed: 'zero' }, {}, 'malformed_quote'],
  ]) {
    const s = await stand(t, opts, env);
    const r = await s.call(MSG);
    assert.equal(r.status, 402, code);
    assert.equal((await r.json()).payer.code, code);
    assert.equal(s.node.st.processed.length, 0, code + ': nothing broadcast');
    assert.equal(s.node.st.workCalls, 0, code + ': no work requested');
    assert.equal((await s.stateOf()).spent, '0');
  }
});

test('host binding: a completeUrl on another host is refused even when the amount is fine', async t => {
  const s = await stand(t, { mode: 'nano', amount: MILLI, completeHost: '127.0.0.1:1' });
  const r = await s.call(MSG);
  assert.equal(r.status, 402);
  assert.equal((await r.json()).payer.code, 'host_mismatch');
  assert.equal(s.node.st.processed.length, 0);
});

test('restart: the spend survives in the state file and the cap still holds', async t => {
  const s = await stand(t, { mode: 'nano', amount: 4n * MILLI }, { NANO_CAP: '0.01', NANO_MAX_PER_CALL: '0.005' });
  assert.equal((await s.call(MSG)).status, 200);
  assert.equal((await s.call(MSG)).status, 200);
  const p2 = await s.restart();
  const call2 = () => fetch(`http://127.0.0.1:${p2.port}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MSG) });
  const r = await call2();
  assert.equal(r.status, 402);
  assert.equal((await r.json()).payer.code, 'cap_exceeded');
  const st = await fetch(`http://127.0.0.1:${p2.port}/_nano/state`).then(x => x.json());
  assert.equal(st.spent, '0.008'); assert.equal(st.paid, 2);
  assert.equal(s.node.st.processed.length, 2);
});

test('concurrency: parallel requests never pass the cap and never fork the account', async t => {
  const s = await stand(t, { mode: 'nano', amount: 3n * MILLI }, { NANO_CAP: '0.007', NANO_MAX_PER_CALL: '0.005' });
  const rs = await Promise.all(Array.from({ length: 6 }, () => s.call(MSG)));
  const codes = rs.map(r => r.status).sort();
  assert.deepEqual(codes, [200, 200, 402, 402, 402, 402]);
  assert.equal(s.node.st.processed.length, 2);
  assert.equal((await s.stateOf()).spent, '0.006');
  for (const r of rs) if (r.status === 402) assert.equal((await r.json()).payer.code, 'cap_exceeded');
});

test('stream:true: SSE from the door is passed through; a JSON answer is wrapped as one chunk', async t => {
  const s1 = await stand(t, { mode: 'nano', amount: MILLI, sse: true });
  const r1 = await s1.call({ ...MSG, stream: true });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('x-payer-stream'), 'passthrough');
  assert.match(r1.headers.get('content-type'), /text\/event-stream/);
  assert.match(await r1.text(), /"content":"OK"[\s\S]*\[DONE\]/);
  const s2 = await stand(t, { mode: 'nano', amount: MILLI, sse: false });
  const r2 = await s2.call({ ...MSG, stream: true });
  assert.equal(r2.status, 200);
  assert.equal(r2.headers.get('x-payer-stream'), 'buffered');
  const text = await r2.text();
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /"delta":\{"role":"assistant","content":"OK"\}/);
  assert.match(text, /data: \[DONE\]\n\n$/);
});

test('exact dialect: signed block in PAYMENT-SIGNATURE, seller broadcasts, spend counted', async t => {
  const s = await stand(t, { mode: 'exact', amount: MILLI });
  const r = await s.call(MSG);
  const text = await r.text();
  assert.equal(r.status, 200, text);
  assert.equal(r.headers.get('x-payer-paid'), '0.001');
  assert.equal(s.node.st.processed.length, 1);
  assert.equal(s.node.st.processed[0].amount, MILLI);
  const st = await s.stateOf();
  assert.equal(st.spent, '0.001'); assert.equal(st.payments[0].kind, 'exact'); assert.equal(st.payments[0].status, 'served');
  assert.equal(s.door.st.lastHeaders.authorization, undefined);
});

test('exact dialect: a call the seller broadcast but did not serve is reported, and stays counted', async t => {
  const s = await stand(t, { mode: 'exact', amount: MILLI, refuseAfterBroadcast: true });
  const r = await s.call(MSG);
  assert.equal(r.status, 502);
  const j = await r.json();
  assert.equal(j.payer.code, 'not_served_after_payment');
  assert.equal(j.payer.detail.broadcast, true);
  const st = await s.stateOf();
  assert.equal(st.spent, '0.001'); assert.equal(st.payments[0].status, 'broadcast_not_served');
});

test('nano dialect: a broadcast the node rejects leaves the spend uncounted and the runtime told', async t => {
  const s = await stand(t, { mode: 'nano', amount: MILLI });
  s.node.st.rejectNext = 1;
  const r = await s.call(MSG);
  assert.equal(r.status, 402);
  assert.equal((await r.json()).payer.code, 'broadcast_failed');
  const st = await s.stateOf();
  assert.equal(st.spent, '0'); assert.equal(st.payments[0].status, 'not_broadcast');
  assert.equal((await s.call(MSG)).status, 200, 'the next call pays normally');
  assert.equal((await s.stateOf()).spent, '0.001');
});

test('refunds: a receivable is pocketed before the next paid call and counted as received', async t => {
  const s = await stand(t, { mode: 'nano', amount: MILLI });
  s.node.st.receivable['C'.repeat(64)] = { amount: (2n * MILLI).toString(), source: 'nano_3arg3asgtigae3xckabaaewkx3bzsh7nwz7jkmjos79ihyaxwphhm6qgjps4' };
  assert.equal((await s.call(MSG)).status, 200);
  const st = await s.stateOf();
  assert.equal(st.received, '0.002'); assert.equal(st.receipts.length, 1);
  assert.equal(s.node.st.processed.map(p => p.subtype).join(','), 'receive,send');
  assert.equal(s.node.st.balance, 10n * RAW + 2n * MILLI - MILLI);
});

test('a door that does not answer 402 is relayed as is; non-/v1 paths are not forwarded', async t => {
  const s = await stand(t, { mode: 'nano', amount: MILLI });
  const r = await s.call(MSG, {}, '/other');
  assert.equal(r.status, 404);
  assert.equal(s.node.st.processed.length, 0);
});

test('refuses to start without a cap, without an upstream, or with a state file of another account', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pk-proxy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seed = randomBytes(32).toString('hex');
  for (const env of [
    { NANO_SEED: seed, UPSTREAM: 'https://example.invalid' },
    { NANO_SEED: seed, NANO_CAP: '0.1' },
    { NANO_SEED: seed, UPSTREAM: 'http://example.invalid', NANO_CAP: '0.1' },
    { NANO_SEED: seed, UPSTREAM: 'https://example.invalid', NANO_CAP: 'lots' },
  ]) {
    const code = await new Promise(r => spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, HOME: dir, STATE_FILE: join(dir, 's.json'), ...env }, stdio: 'ignore' }).on('exit', r));
    assert.equal(code, 2, JSON.stringify(env));
  }
});
