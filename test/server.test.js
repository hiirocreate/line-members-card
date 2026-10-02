import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ADMIN_A } from './helpers.js';
import { createServer } from '../src/server.js';

test('公開API: フォーム取得→確認→登録、不正tokenは400', async () => {
  const { app, tokenA } = setup();
  app.forms.applyTemplate(ADMIN_A, 'SHOP001', 'basic');
  const srv = createServer(app).listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const form = await (await fetch(`${base}/t/${tokenA}/form`)).json();
    assert.equal(form.fields.length, 2);
    assert.ok(!('tenant_id' in form.fields[0]));
    const [n, p] = form.fields.map((f) => f.field_id);
    const values = { [n]: '山田', [p]: '09011112222' };
    const post = (path, body) => fetch(`${base}/t/${tokenA}/${path}`, { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await post('confirm', { values })).status, 200);
    assert.equal((await post('register', { userId: 'U1', values })).status, 400); // 未確認
    assert.equal((await post('register', { userId: 'U1', values, confirmed: true })).status, 201);
    assert.equal((await fetch(`${base}/t/${'0'.repeat(32)}/form`)).status, 400);
    assert.match(await (await fetch(`${base}/t/${tokenA}`)).text(), /会員登録/);
  } finally { srv.close(); }
});
