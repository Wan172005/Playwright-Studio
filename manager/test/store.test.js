'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { StudioStore, scriptFilename, hash } = require('../store');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-store-'));
  const store = new StudioStore({ dataDir: path.join(root, 'data'), scriptsDir: path.join(root, 'tests-scripts'), backupDir: path.join(root, 'backups') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { store, root };
}
test('preserves entered filenames, Unicode, case, spaces and explicit .ts suffix', () => {
  assert.equal(scriptFilename('Đăng nhập Thành công'), 'Đăng nhập Thành công.spec.ts');
  assert.equal(scriptFilename('Login.ts'), 'Login.ts');
  assert.equal(scriptFilename('Login.spec.ts'), 'Login.spec.ts');
  for (const name of ['../escape', 'a/b', 'a\\b', '.hidden', 'test ', ' test', 'CON', 'NUL.ts', 'a?b', 'a:b', '']) assert.throws(() => scriptFilename(name));
});
test('requires project, isolates same filename across projects, and detects portable collisions', t => {
  const { store } = fixture(t);
  assert.throws(() => store.target('', 'Login'), /project/);
  const a = store.createProject({ name: 'A' }), b = store.createProject({ name: 'B' });
  store.saveScript(store.target(a.id, 'Đăng nhập'), 'Đăng nhập', 'https://example.com', 'old');
  store.saveScript(store.target(b.id, 'Đăng nhập'), 'Đăng nhập', 'https://example.com', 'other');
  assert.equal(store.scripts(a.id).length, 1);
  assert.equal(store.scripts(b.id).length, 1);
  assert.throws(() => store.target(a.id, 'ĐĂNG NHẬP'), error => error.status === 409 && error.details.code === 'OVERWRITE_REQUIRED');
});
test('overwrite requires current hash and retains original when file changes during session', t => {
  const { store } = fixture(t); const project = store.createProject({ name: 'A' });
  const script = store.saveScript(store.target(project.id, 'Login'), 'Login', '', 'original');
  assert.throws(() => store.target(project.id, 'Login'), error => error.details.overwriteHash === hash('original'));
  const target = store.target(project.id, 'Login', hash('original'));
  fs.writeFileSync(target.file, 'external edit');
  assert.throws(() => store.saveScript(target, 'Login', '', 'replacement'), /thay đổi/);
  assert.equal(fs.readFileSync(store.scriptPath(script), 'utf8'), 'external edit');
  assert.throws(() => store.target(project.id, 'Login', hash('original')), error => error.status === 409);
});
test('versioned snapshots include recoverable SQLite, exact script content and checksum', t => {
  const { store, root } = fixture(t); const project = store.createProject({ name: 'A' });
  let script = store.saveScript(store.target(project.id, 'Login'), 'Login', 'https://example.com', 'version 1');
  assert.equal(store.backup().pending, false);
  const first = fs.readdirSync(path.join(root, 'backups'))[0];
  const snapshot = path.join(root, 'backups', first);
  const restored = new DatabaseSync(path.join(snapshot, 'studio.sqlite'), { readOnly: true });
  assert.equal(restored.prepare('SELECT filename FROM scripts').get().filename, 'Login.spec.ts'); restored.close();
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files[0].sha256, hash('version 1'));
  script = store.saveScript(store.target(project.id, 'Login', hash('version 1')), 'Login', '', 'version 2');
  store.backup(); store.deleteScript(script.id); store.backup();
  assert.equal(fs.readFileSync(path.join(snapshot, 'tests-scripts', project.id, 'Login.spec.ts'), 'utf8'), 'version 1');
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 3);
  assert.equal(store.scripts(project.id).length, 0);
});
test('failed backup stays pending and succeeds on retry without losing saved scripts', t => {
  const { store, root } = fixture(t); const project = store.createProject({ name: 'A' });
  store.saveScript(store.target(project.id, 'Login'), 'Login', '', 'saved');
  fs.writeFileSync(path.join(root, 'blocked'), 'file'); store.backupDir = path.join(root, 'blocked', 'backups');
  assert.equal(store.backup().pending, true); assert.ok(store.backupStatus().error);
  store.backupDir = path.join(root, 'backups');
  assert.equal(store.backup().pending, false); assert.equal(store.backupStatus().error, '');
});
test('rejects symlink script targets', t => {
  const { store, root } = fixture(t); const project = store.createProject({ name: 'A' });
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(store.projectDir(project.id), 'Login.spec.ts'));
  assert.throws(() => store.target(project.id, 'Login'), /thông thường/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
});
test('recovers an interrupted save or external edit and backs it up with correct revision', t => {
  const { store, root } = fixture(t); const project = store.createProject({ name: 'A' });
  const file = path.join(store.projectDir(project.id), 'Recovered.ts');
  fs.writeFileSync(file, 'recovered source');
  assert.equal(store.backup().pending, false);
  const script = store.scripts(project.id)[0];
  assert.equal(script.filename, 'Recovered.ts');
  assert.equal(script.backupStatus, 'saved');
  fs.writeFileSync(file, 'edited source');
  assert.equal(store.reconcile(), true);
  assert.equal(store.scripts(project.id)[0].backupStatus, 'pending');
  assert.equal(store.backup().pending, false);
  assert.equal(store.script(script.id).hash, hash('edited source'));
  const copies = fs.readdirSync(path.join(root, 'backups')).map(dir => fs.readFileSync(path.join(root, 'backups', dir, 'tests-scripts', project.id, 'Recovered.ts'), 'utf8'));
  assert.deepEqual(new Set(copies), new Set(['recovered source', 'edited source']));
});
test('projects, scripts and backup state survive reopening SQLite and regenerate the Playwright manifest', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-reopen-'));
  const options = { dataDir: path.join(root, 'data'), scriptsDir: path.join(root, 'tests-scripts'), backupDir: path.join(root, 'backups') };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let store = new StudioStore(options);
  const project = store.createProject({ name: 'Persistent project' });
  store.saveScript(store.target(project.id, 'Keep.ts'), 'Keep', '', 'persistent source');
  store.backup(); store.close();
  fs.unlinkSync(path.join(options.dataDir, 'projects.json'));
  store = new StudioStore(options);
  try {
    assert.equal(store.projects()[0].name, 'Persistent project');
    assert.equal(store.scripts(project.id)[0].filename, 'Keep.ts');
    assert.equal(store.backupStatus().pending, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(options.dataDir, 'projects.json'), 'utf8'))[0].id, project.id);
  } finally { store.close(); }
});
test('local backup uses project names, exact filenames and keeps deleted files while snapshots preserve versions', t => {
  const { store, root } = fixture(t);
  store.localScriptsDir = path.join(root, 'local/tests-scripts');
  const a = store.createProject({ name: 'Practice Automation' }), b = store.createProject({ name: 'Shop Demo' });
  let script = store.saveScript(store.target(a.id, 'Đăng nhập.ts'), 'Đăng nhập', '', 'first version');
  store.saveScript(store.target(b.id, 'Đăng nhập.ts'), 'Đăng nhập', '', 'other project');
  assert.equal(store.backup().pending, false);
  const local = path.join(store.localScriptsDir, 'Practice Automation', 'Đăng nhập.ts');
  assert.equal(fs.readFileSync(local, 'utf8'), 'first version');
  assert.equal(fs.readFileSync(path.join(store.localScriptsDir, 'Shop Demo', 'Đăng nhập.ts'), 'utf8'), 'other project');
  script = store.saveScript(store.target(a.id, script.filename, hash('first version')), 'Đăng nhập', '', 'second version');
  assert.equal(store.backup().pending, false);
  assert.equal(fs.readFileSync(local, 'utf8'), 'second version');
  store.deleteScript(script.id); store.backup(); store.deleteProject(a.id); store.backup();
  assert.equal(fs.readFileSync(local, 'utf8'), 'second version');
  const prior = fs.readdirSync(path.join(root, 'backups')).some(dir => {
    const file = path.join(root, 'backups', dir, 'tests-scripts', a.id, script.filename);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'first version';
  });
  assert.ok(prior);
});
test('local project folders sanitize paths, avoid collisions and never adopt unrelated existing folders', t => {
  const { store, root } = fixture(t);
  store.localScriptsDir = path.join(root, 'local/tests-scripts');
  fs.mkdirSync(path.join(store.localScriptsDir, 'Existing'), { recursive: true });
  fs.writeFileSync(path.join(store.localScriptsDir, 'Existing/Keep.ts'), 'unrelated');
  const a = store.createProject({ name: 'Shop / Demo' }), b = store.createProject({ name: 'Shop : Demo' });
  const c = store.createProject({ name: 'CON' }), d = store.createProject({ name: '..' }), e = store.createProject({ name: 'Existing' });
  for (const p of [a,b,c,d,e]) store.saveScript(store.target(p.id, 'Keep.ts'), 'Keep', '', p.name);
  assert.equal(store.backup().pending, false);
  const folders = [a,b,c,d,e].map(p => store.localProjectFolder(p));
  assert.equal(new Set(folders.map(f => f.toLowerCase())).size, 5);
  for (let i = 0; i < folders.length; i++) {
    assert.equal(path.dirname(path.resolve(store.localScriptsDir, folders[i])), path.resolve(store.localScriptsDir));
    assert.equal(fs.readFileSync(path.join(store.localScriptsDir, folders[i], 'Keep.ts'), 'utf8'), [a,b,c,d,e][i].name);
  }
  assert.equal(fs.readFileSync(path.join(store.localScriptsDir, 'Existing/Keep.ts'), 'utf8'), 'unrelated');
  assert.equal(store.localProjectFolder(a), folders[0]);
});
test('local backup failure stays pending and retry fills local project folders', t => {
  const { store, root } = fixture(t);
  const project = store.createProject({ name: 'Local retry' });
  store.saveScript(store.target(project.id, 'Keep.ts'), 'Keep', '', 'source');
  fs.writeFileSync(path.join(root, 'blocked-local'), 'file');
  store.localScriptsDir = path.join(root, 'blocked-local/tests-scripts');
  assert.equal(store.backup().pending, true);
  assert.ok(store.backupStatus().error);
  assert.equal(store.scripts(project.id)[0].backupStatus, 'pending');
  store.localScriptsDir = path.join(root, 'local/tests-scripts');
  assert.equal(store.backup().pending, false);
  assert.equal(fs.readFileSync(path.join(store.localScriptsDir, 'Local retry/Keep.ts'), 'utf8'), 'source');
});
test('enabling local copies after a saved snapshot marks backup pending and exports existing scripts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-local-migration-'));
  const options = { dataDir: path.join(root, 'data'), scriptsDir: path.join(root, 'volume/scripts'), backupDir: path.join(root, 'backups') };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let store = new StudioStore(options);
  const project = store.createProject({ name: 'Existing project' });
  store.saveScript(store.target(project.id, 'log in.spec.ts'), 'log in', '', 'existing source');
  store.backup(); store.close();
  store = new StudioStore({ ...options, localScriptsDir: path.join(root, 'tests-scripts') });
  try {
    assert.equal(store.backupStatus().pending, true);
    assert.equal(store.backup().pending, false);
    assert.equal(fs.readFileSync(path.join(root, 'tests-scripts/Existing project/log in.spec.ts'), 'utf8'), 'existing source');
    assert.equal(store.localProjectFolder(project), 'Existing project');
  } finally { store.close(); }
});
