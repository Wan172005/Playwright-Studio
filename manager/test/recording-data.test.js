'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { once } = require('node:events');
const { parameterizeRecording, generatedCallTexts } = require('../recording-data');
const { testBody, appendSteps } = require('../recording-draft');
const { createStudioServer } = require('../server');
const { hash } = require('../store');
const options = { filename: '/tmp/project/login.ts', runtimeFile: path.resolve(__dirname, '../runtime/dataset.ts'), baseUrl: 'https://staging.example.com/login' };
const recording = `import { test, expect } from '@playwright/test';
test('login', async ({ page }) => {
 await page.goto('https://staging.example.com/login');
 await page.getByRole('textbox', { name: 'Username' }).fill('new-user');
 await page.getByLabel('Password').fill('secret-value');
 await page.getByRole('textbox', { name: 'Username' }).fill('invalid-user');
 await page.locator('#country').selectOption('VN');
 await expect(page.getByLabel('Username')).toHaveValue('invalid-user');
 await page.getByRole('button', { name: 'Submit' }).click();
});`;
test('recording extracts input data, navigation and expected values while retaining selectors and names', () => {
  const existing = { BASE_URL: 'https://production.example.com', Username: 'new-user', KEEP: 'unchanged' };
  const { source, variables } = parameterizeRecording(recording, options, existing);
  assert.ok(source.includes("{ name: 'Username' }).fill(data(\"Username\"))"));
  assert.ok(source.includes('data("Username_2")')); assert.ok(source.includes('webUrl(data("URL_1"))'));
  assert.ok(source.includes("{ name: 'Submit' }).click()"));
  for (const literal of ['new-user', 'secret-value', 'invalid-user', 'https://staging.example.com', "'VN'"]) assert.ok(!source.includes(literal));
  assert.equal(variables.Username_2, 'invalid-user'); assert.equal(variables.Password, 'secret-value');
  assert.equal(variables.country, 'VN'); assert.equal(variables.Username_Expected, 'invalid-user');
  assert.equal(variables.BASE_URL, existing.BASE_URL); assert.equal(variables.KEEP, 'unchanged');
  assert.deepEqual(existing, { BASE_URL: 'https://production.example.com', Username: 'new-user', KEEP: 'unchanged' });
  assert.equal(parameterizeRecording(source, options, variables).source, source);
  const next = parameterizeRecording(recording.replace('/login\');', '/logout\');').replace("'new-user'", "'another-user'"), options, variables);
  assert.equal(next.variables.Username, 'new-user'); assert.equal(next.variables.Username_3, 'another-user');
  assert.equal(next.variables.URL_1, '/login'); assert.equal(next.variables.URL_1_2, '/logout');
});
test('resumed steps are appended inside the edited test and retain dataset conversion', () => {
  const edited = recording.replace('new-user', 'fixed-user');
  const added = "  await page.getByLabel('Username').fill('resumed-user');";
  const draft = appendSteps(edited + '\n// end of script\n', added, options.filename);
  const generatedCalls = new Set([
    ...generatedCallTexts(recording, options.filename),
    ...generatedCallTexts(appendSteps("test('draft', async () => {});", added, options.filename), options.filename),
  ]);
  const { source, variables } = parameterizeRecording(draft, { ...options, generatedCalls });
  assert.match(source, /fill\('fixed-user'\)/);
  assert.match(source, /fill\(data\("Username_2"\)\);\n}\);\n\/\/ end of script/);
  assert.equal(variables.Username_2, 'resumed-user');
  assert.ok(!Object.values(variables).includes('fixed-user'));
  assert.throws(() => testBody(edited + '\n{', options.filename), /TypeScript/);
});

test('recording saves into the captured environment, shares datasets, and manual edits keep hardcode intact', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-recording-'));
  const app = createStudioServer({ dataDir: path.join(root, 'data'), scriptsDir: path.join(root, 'scripts'), localScriptsDir: path.join(root, 'local'), backupDir: path.join(root, 'backups'), cli: path.join(__dirname, 'fixtures/fake-playwright.cjs') });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => { app.close(); app.store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(url, body) {
    const r = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }
  async function waitFor(fn) { for (let i=0; i<250; i++) { if (fn()) return; await new Promise(r=>setTimeout(r,20)); } throw new Error('Timeout'); }
  const p = app.store.createProject({ name: 'A', url: 'https://staging.example.com' });
  const env = app.store.saveEnvironment(p.id, { name: 'staging', variables: { BASE_URL: 'https://staging.example.com', Username: 'new-user' } });
  const prod = app.store.saveEnvironment(p.id, { name: 'production', variables: { BASE_URL: 'https://production.example.com' } });
  async function record(name, environmentId) {
    assert.equal((await request('/api/scripts/start', { name, projectId: p.id, url: options.baseUrl, environmentId })).status, 200);
    await waitFor(()=>fs.existsSync(app.state.session.draft)); fs.writeFileSync(app.state.session.draft,recording);
    await request('/api/scripts/stop', {}); await waitFor(()=>!app.state.session);
    const script=app.store.scripts(p.id).find(s=>s.filename===name); assert.ok(script,app.state.message); return script;
  }
  const one = await record('one.ts', env.id), two = await record('two.ts', env.id);
  const savedEnvironment = app.store.environment(env.id, p.id);
  assert.equal(savedEnvironment.variables.Username, 'new-user'); assert.equal(savedEnvironment.variables.Password, 'secret-value');
  assert.equal(Object.keys(savedEnvironment.variables).length, 7);
  assert.deepEqual(app.store.environment(prod.id,p.id).variables, prod.variables);
  const source = fs.readFileSync(app.store.scriptPath(one),'utf8'); assert.ok(source.includes('data("Username")'));
  assert.equal(fs.readFileSync(app.store.scriptPath(two),'utf8'),source);
  const manual = source.replace('data("Username")', '"manual-user"');
  const result=await request(`/api/scripts/${one.id}/source`, { source:manual, expectedHash:hash(source) });
  assert.equal(result.status,200); assert.equal(result.body.source,manual);
  assert.equal(fs.readFileSync(app.store.scriptPath(one),'utf8'),manual);
  assert.equal(app.store.environment(env.id,p.id).updatedAt,savedEnvironment.updatedAt);
  assert.equal(fs.readFileSync(path.join(root,'local/A/one.ts'),'utf8'),manual);
  await record('default.ts');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'data/projects.json'),'utf8'))[0];
  assert.ok(manifest.defaultEnvironmentId); assert.equal(app.store.environment(manifest.defaultEnvironmentId,p.id).variables.Username,'new-user');
  const cloned=app.store.cloneProject(p.id,{name:'Cloned'});
  const clonedManifest=JSON.parse(fs.readFileSync(path.join(root,'data/projects.json'),'utf8')).find(x=>x.id===cloned.id);
  assert.ok(clonedManifest.defaultEnvironmentId); assert.notEqual(clonedManifest.defaultEnvironmentId,manifest.defaultEnvironmentId);
  assert.equal((await request('/api/scripts/start',{name:'bad.ts',projectId:cloned.id,url:options.baseUrl,environmentId:env.id})).status,404);
});
test('failed script write rolls back both dataset values and generated source', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'studio-recording-rollback-'));
  const app=createStudioServer({dataDir:path.join(root,'data'),scriptsDir:path.join(root,'scripts'),localScriptsDir:path.join(root,'local'),backupDir:path.join(root,'backups')});
  t.after(()=>{app.close();app.store.close();fs.rmSync(root,{recursive:true,force:true});});
  const p=app.store.createProject({name:'Rollback'}),e=app.store.recordingEnvironment(p.id,null,options.baseUrl);
  const s=app.store.saveScript(app.store.target(p.id,'a.ts'),'a','',recording);
  const original=app.store.saveScript.bind(app.store);
  app.store.saveScript=(...args)=>{original(...args);throw new Error('disk failure');};
  assert.throws(()=>app.store.saveRecordedScript(app.store.target(p.id,'a.ts',hash(recording)),'a','', 'changed',e.id,{...e.variables,NEW:'new'}),/disk failure/);
  assert.equal(fs.readFileSync(app.store.scriptPath(s),'utf8'),recording);
  assert.deepEqual(app.store.environment(e.id,p.id).variables,e.variables);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'data/datasets',e.id+'.json'),'utf8')),e.variables);
});
