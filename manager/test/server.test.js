'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { createStudioServer } = require('../server');
async function waitFor(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) { if (Date.now() > deadline) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
test('HTTP workflow: projects, source, staged save, overwrite confirmation, UI target and deletion', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-api-'));
  const app = createStudioServer({ dataDir: path.join(root, 'data'), scriptsDir: path.join(root, 'tests-scripts'), localScriptsDir: path.join(root, 'local/tests-scripts'), backupDir: path.join(root, 'backups'), cli: path.join(__dirname, 'fixtures/fake-playwright.cjs') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => { app.close(); app.store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(url, method = 'GET', body) {
    const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  assert.equal((await request('/api/scripts/start', 'POST', { name: 'Login' })).status, 400);
  const result = await request('/api/projects', 'POST', { name: 'Practice + Demo', url: 'example.com' });
  assert.equal(result.status, 201); const project = result.body.project;
  const payload = { projectId: project.id, name: 'Đăng nhập $& [OK].ts', url: 'https://example.com' };
  assert.equal((await request('/api/scripts/start', 'POST', payload)).status, 200);
  await waitFor(() => fs.existsSync(app.state.session.draft));
  assert.equal((await request('/api/scripts/stop', 'POST', {})).status, 200);
  await waitFor(() => !app.state.session);
  let script = app.store.scripts(project.id)[0];
  assert.equal(script.filename, 'Đăng nhập $& [OK].ts');
  const original = fs.readFileSync(app.store.scriptPath(script), 'utf8');
  assert.ok(original.includes('test("Đăng nhập $& [OK]",'));
  const conflict = await request('/api/scripts/start', 'POST', payload);
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'OVERWRITE_REQUIRED');
  assert.equal(app.state.session, null); assert.equal(fs.readFileSync(app.store.scriptPath(script), 'utf8'), original);
  assert.equal((await request('/api/scripts/start', 'POST', { ...payload, overwriteHash: conflict.body.overwriteHash })).status, 200);
  await waitFor(() => fs.existsSync(app.state.session.draft));
  assert.equal(fs.readFileSync(app.store.scriptPath(script), 'utf8'), original);
  assert.equal((await request(`/api/scripts/${script.id}/open-ui`, 'POST', {})).status, 409);
  await request('/api/scripts/stop', 'POST', {}); await waitFor(() => !app.state.session);
  const opened = await request(`/api/scripts/${script.id}/open-ui`, 'POST', {});
  assert.equal(opened.status, 200);
  const target = new URL(opened.body.url, base);
  assert.equal(target.searchParams.get('project'), project.name);
  assert.equal(target.searchParams.get('studioFile'), script.filename);
  assert.ok(new RegExp(target.searchParams.get('arg')).test(app.store.scriptPath(script)));
  assert.equal((await request(`/api/scripts/${script.id}/source`)).body.source, original);
  const denied = await fetch(base + '/api/projects', { method: 'POST', headers: { Origin: 'https://unrelated.test', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  assert.equal((await request(`/api/projects/${project.id}`, 'DELETE')).status, 409);
  // A user can remove metadata for a file deleted externally, without blocking all backups forever.
  const missing = app.store.saveScript(app.store.target(project.id, 'Missing'), 'Missing', '', 'source');
  app.store.backup(); fs.unlinkSync(app.store.scriptPath(missing));
  assert.equal((await request(`/api/scripts/${missing.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/scripts/${script.id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/api/projects/${project.id}`, 'DELETE')).status, 200);
  assert.equal((await request('/api/state')).body.projects.length, 0);
});
