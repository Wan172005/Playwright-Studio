'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { parseEnv } = require('node:util');
const { runtimeProjectName } = require('./project-runtime');

class ApiError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}

function scriptFilename(value) {
  const name = String(value || '');
  // Preserve spelling, accents, spaces and case. Reject unsafe names instead of silently changing them.
  if (!name || name !== name.trim() || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || name.startsWith('.') ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new ApiError(400, 'Tên file không hợp lệ. Không dùng đường dẫn, ký tự <>:"/\\|?*, tên hệ thống hoặc khoảng trắng ở đầu/cuối.');
  }
  const filename = name.endsWith('.ts') ? name : `${name}.spec.ts`;
  if (Buffer.byteLength(filename) > 220) throw new ApiError(400, 'Tên file quá dài (tối đa 220 byte, bao gồm .spec.ts).');
  return filename;
}

const hash = source => createHash('sha256').update(source).digest('hex');
const fileKey = name => name.normalize('NFC').toLowerCase();
function atomicWrite(file, data) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, data);
  fs.renameSync(temp, file);
}

function projectFolderName(name) {
  let folder = String(name).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/^\.+|[. ]+$/g, '').trim();
  if (!folder) folder = 'Project';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(folder)) folder = `Project-${folder}`;
  while (Buffer.byteLength(folder) > 180) folder = Array.from(folder).slice(0, -1).join('');
  return folder;
}

class StudioStore {
  constructor({ dataDir, scriptsDir, backupDir, localScriptsDir }) {
    Object.assign(this, { dataDir, scriptsDir, backupDir, localScriptsDir });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });
    if (path.resolve(backupDir) === path.resolve(scriptsDir) || path.resolve(backupDir).startsWith(path.resolve(scriptsDir) + path.sep)) {
      throw new Error('BACKUP_DIR phải nằm ngoài tests-scripts.');
    }
    if (localScriptsDir) {
      const local = path.resolve(localScriptsDir), primary = path.resolve(scriptsDir), archive = path.resolve(backupDir);
      const overlaps = other => local === other || local.startsWith(other + path.sep) || other.startsWith(local + path.sep);
      if (overlaps(primary) || overlaps(archive)) throw new Error('Thư mục bản sao local cần tách khỏi volume script và thư mục snapshot.');
    }
    this.db = new DatabaseSync(path.join(dataDir, 'studio.sqlite'));
    fs.chmodSync(path.join(dataDir, 'studio.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS project_name ON projects(name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS scripts(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, filename TEXT NOT NULL, fileKey TEXT NOT NULL, url TEXT NOT NULL,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, hash TEXT NOT NULL, revision INTEGER NOT NULL,
        UNIQUE(projectId, fileKey));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS environments(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL, variables TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(projectId, name));
      INSERT OR IGNORE INTO settings VALUES('revision','0'),('backupRevision','-1'),('localRevision','-1'),('backupAt',''),('backupError','');`);
    if (localScriptsDir && this.get('localScriptsDir') !== path.resolve(localScriptsDir)) {
      this.set('localScriptsDir', path.resolve(localScriptsDir));
      this.set('localRevision', -1);
    }
    this.syncDatasetFiles();
    this.writeManifest();
  }
  get(key) { return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || ''; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, String(value)); }
  touch() { const revision = Number(this.get('revision')) + 1; this.set('revision', revision); return revision; }
  projects() { return this.db.prepare('SELECT p.*, (SELECT COUNT(*) FROM scripts s WHERE s.projectId=p.id) AS scriptCount FROM projects p ORDER BY createdAt').all(); }
  project(id) {
    const project = this.db.prepare('SELECT * FROM projects WHERE id=?').get(String(id || ''));
    if (!project) throw new ApiError(404, 'Hãy tạo hoặc chọn project hợp lệ trước.');
    return project;
  }
  projectDir(id) { return path.join(this.scriptsDir, this.project(id).id); }
  script(id) {
    const script = this.db.prepare('SELECT * FROM scripts WHERE id=?').get(String(id || ''));
    if (!script) throw new ApiError(404, 'Không tìm thấy test script.');
    return script;
  }
  scriptPath(script) {
    const dir = this.projectDir(script.projectId);
    const file = path.join(dir, scriptFilename(script.filename));
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new ApiError(400, 'Test script phải là file thông thường.');
    return file;
  }
  scripts(projectId) {
    this.project(projectId);
    return this.db.prepare('SELECT * FROM scripts WHERE projectId=? ORDER BY updatedAt DESC').all(projectId).map(script => ({
      ...script, backupStatus: script.revision <= this.backedUpRevision() ? 'saved' : 'pending',
      exists: fs.existsSync(this.scriptPath(script)),
    }));
  }
  reconcile() {
    // Recover a save interrupted between filesystem rename and SQLite commit, and pick up host edits.
    let changed = false;
    for (const project of this.projects()) {
      const dir = this.projectDir(project.id);
      fs.mkdirSync(dir, { recursive: true });
      for (const filename of fs.readdirSync(dir)) {
        if (!filename.endsWith('.ts')) continue;
        scriptFilename(filename);
        const file = path.join(dir, filename), stat = fs.lstatSync(file);
        if (!stat.isFile()) throw new ApiError(400, `File ${filename} phải là file thông thường.`);
        const existing = this.db.prepare('SELECT * FROM scripts WHERE projectId=? AND fileKey=?').get(project.id, fileKey(filename));
        if (existing && existing.filename !== filename) throw new ApiError(409, `Hai file trùng tên khi bỏ qua hoa/thường: ${existing.filename} và ${filename}.`);
        const digest = hash(fs.readFileSync(file));
        if (existing?.hash === digest) continue;
        const revision = this.touch(), now = stat.mtime.toISOString();
        this.db.prepare(`INSERT INTO scripts VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          hash=excluded.hash,updatedAt=excluded.updatedAt,revision=excluded.revision`)
          .run(existing?.id || randomUUID(), project.id, existing?.name || filename.replace(/\.spec\.ts$|\.ts$/, ''), filename,
            fileKey(filename), existing?.url || project.url, existing?.createdAt || now, now, digest, revision);
        changed = true;
      }
    }
    return changed;
  }
  projectName(payload) {
    const name = String(payload.name || '').trim();
    if (!name || name.length > 100) throw new ApiError(400, 'Tên project cần từ 1 đến 100 ký tự.');
    if (/[\x00-\x1f\x7f*?]/.test(name)) throw new ApiError(400, 'Tên project không dùng ký tự điều khiển, * hoặc ?.');
    return name;
  }
  createProject(payload) {
    const name = this.projectName(payload);
    if (this.projects().some(p => fileKey(p.name) === fileKey(name))) throw new ApiError(409, 'Tên project đã tồn tại.');
    if (this.projects().some(p => this.environments(p.id).some(e => fileKey(runtimeProjectName(p, e)) === fileKey(name)))) throw new ApiError(409, 'Tên trùng với một cấu hình môi trường Playwright.');
    const project = { id: randomUUID(), name, url: payload.url || '', createdAt: new Date().toISOString() };
    fs.mkdirSync(path.join(this.scriptsDir, project.id));
    this.db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run(project.id, name, project.url, project.createdAt);
    this.touch(); this.writeManifest();
    return project;
  }
  renameProject(id, payload) {
    const project = this.project(id), name = this.projectName(payload);
    if (payload.expectedName !== project.name) throw new ApiError(409, 'Tên project đã thay đổi. Hãy tải lại và thử lại.');
    if (name === project.name) return project;
    const proposed = [name, ...this.environments(id).map(e => runtimeProjectName({ name }, e))].map(fileKey);
    for (const other of this.projects().filter(p => p.id !== id)) {
      const names = [other.name, ...this.environments(other.id).map(e => runtimeProjectName(other, e))];
      if (names.some(n => proposed.includes(fileKey(n)))) throw new ApiError(409, 'Tên trùng với project hoặc cấu hình môi trường Playwright đã có.');
    }
    const settingKey = `localFolder:${id}`, oldFolder = this.get(settingKey);
    let folder, oldDirectory, newDirectory, moved = false;
    if (this.localScriptsDir) {
      const used = new Set(this.db.prepare("SELECT key,value FROM settings WHERE key LIKE 'localFolder:%'").all().filter(row => row.key !== settingKey).map(row => fileKey(row.value)));
      if (fs.existsSync(this.localScriptsDir)) {
        if (!fs.lstatSync(this.localScriptsDir).isDirectory()) throw new ApiError(409, 'Thư mục backup local không hợp lệ.');
        for (const entry of fs.readdirSync(this.localScriptsDir)) if (entry !== oldFolder) used.add(fileKey(entry));
      }
      const base = projectFolderName(name);
      folder = base;
      let index = 1;
      while (used.has(fileKey(folder))) folder = `${base}-${id}${index++ > 1 ? `-${index - 1}` : ''}`;
      if (oldFolder) oldDirectory = path.join(this.localScriptsDir, oldFolder);
      newDirectory = path.join(this.localScriptsDir, folder);
      if (oldDirectory && fs.existsSync(oldDirectory) && !fs.lstatSync(oldDirectory).isDirectory()) throw new ApiError(409, 'Thư mục backup của project không hợp lệ.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (oldDirectory && oldDirectory !== newDirectory && fs.existsSync(oldDirectory)) {
        fs.renameSync(oldDirectory, newDirectory); moved = true;
      }
      this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(name, id);
      if (folder) this.set(settingKey, folder);
      this.touch(); this.writeManifest(); this.db.exec('COMMIT');
      return this.project(id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (moved) fs.renameSync(newDirectory, oldDirectory);
      this.writeManifest(); throw error;
    }
  }
  writeManifest() {
    atomicWrite(path.join(this.dataDir, 'projects.json'), JSON.stringify(this.projects().map(p => ({ id: p.id, name: p.name, url: p.url,
      defaultEnvironmentId: this.get(`defaultEnvironment:${p.id}`) || undefined,
      environments: this.environments(p.id).map(e => ({ id: e.id, name: e.name, baseURL: e.baseURL })) })), null, 2));
  }
  recordingEnvironment(projectId, environmentId, url) {
    if (environmentId) return this.environment(environmentId, projectId);
    const defaultId = this.get(`defaultEnvironment:${projectId}`);
    if (defaultId) return this.environment(defaultId, projectId);
    const existing = this.environments(projectId).find(e => e.name.toLowerCase() === 'default');
    const environment = existing ? this.environment(existing.id, projectId) : this.saveEnvironment(projectId, { name: 'default', variables: { BASE_URL: new URL(url).origin } });
    this.set(`defaultEnvironment:${projectId}`, environment.id); this.touch(); this.writeManifest();
    return environment;
  }
  saveRecordedScript(target, name, url, source, environmentId, variables) {
    const environment = this.environment(environmentId, target.projectId);
    const original = fs.existsSync(target.file) ? fs.readFileSync(target.file) : null;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveEnvironment(target.projectId, { ...environment, variables, expectedUpdatedAt: environment.updatedAt });
      const script = this.saveScript(target, name, url, source);
      this.db.exec('COMMIT'); return script;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (original !== null) atomicWrite(target.file, original); else fs.rmSync(target.file, { force: true });
      this.syncDatasetFiles(); this.writeManifest(); throw error;
    }
  }
  environment(id, projectId) {
    const row = this.db.prepare('SELECT * FROM environments WHERE id=? AND projectId=?').get(String(id || ''), projectId);
    if (!row) throw new ApiError(404, 'Không tìm thấy môi trường trong project.');
    return { ...row, variables: JSON.parse(row.variables) };
  }
  environments(projectId) {
    this.project(projectId);
    return this.db.prepare('SELECT * FROM environments WHERE projectId=? ORDER BY name').all(projectId).map(row => {
      const variables = JSON.parse(row.variables);
      return { id: row.id, name: row.name, updatedAt: row.updatedAt, baseURL: variables.BASE_URL || '', variableCount: Object.keys(variables).length };
    });
  }
  saveEnvironment(projectId, payload) {
    this.project(projectId);
    const name = String(payload.name || '').trim();
    if (!name || name.length > 60 || /[\x00-\x1f*?]/.test(name)) throw new ApiError(400, 'Tên môi trường cần từ 1–60 ký tự và không dùng * hoặc ?.');
    let variables = payload.variables;
    if (payload.envText !== undefined) {
      if (typeof payload.envText !== 'string' || Buffer.byteLength(payload.envText) > 128 * 1024) throw new ApiError(400, 'File .env quá lớn (tối đa 128 KiB).');
      variables = parseEnv(payload.envText);
      if (!Object.keys(variables).length && payload.envText.trim()) throw new ApiError(400, 'File .env không có biến hợp lệ.');
    }
    if (!variables || typeof variables !== 'object' || Array.isArray(variables) || Object.keys(variables).length > 200) throw new ApiError(400, 'Dataset cần tối đa 200 biến.');
    const clean = Object.create(null);
    for (const [key, value] of Object.entries(variables)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key) || typeof value !== 'string' || Buffer.byteLength(value) > 8192) throw new ApiError(400, 'Tên biến không hợp lệ hoặc giá trị dài quá 8 KiB.');
      clean[key] = value;
    }
    if (clean.BASE_URL) {
      let url;
      try { url = new URL(clean.BASE_URL); } catch { throw new ApiError(400, 'BASE_URL cần là URL HTTP/HTTPS đầy đủ.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ApiError(400, 'BASE_URL cần là HTTP/HTTPS và không chứa mật khẩu.');
    }
    const existing = payload.id ? this.environment(payload.id, projectId) : null;
    if (existing && payload.expectedUpdatedAt !== existing.updatedAt) throw new ApiError(409, 'Dataset đã thay đổi. Hãy tải lại trước khi lưu.');
    const duplicate = this.environments(projectId).find(e => fileKey(e.name) === fileKey(name) && e.id !== existing?.id);
    if (duplicate) throw new ApiError(409, 'Tên môi trường đã tồn tại.');
    const runtimeName = fileKey(runtimeProjectName(this.project(projectId), { name }));
    if (this.projects().some(p => fileKey(p.name) === runtimeName || this.environments(p.id).some(e => e.id !== existing?.id && fileKey(runtimeProjectName(p, e)) === runtimeName))) throw new ApiError(409, 'Tên môi trường gây trùng cấu hình Playwright.');
    const id = existing?.id || randomUUID(), updatedAt = new Date(Math.max(Date.now(), existing ? Date.parse(existing.updatedAt) + 1 : 0)).toISOString();
    this.db.prepare(`INSERT INTO environments VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,variables=excluded.variables,updatedAt=excluded.updatedAt`)
      .run(id, projectId, name, JSON.stringify(clean), updatedAt);
    this.touch(); this.syncDatasetFiles(); this.writeManifest();
    return this.environment(id, projectId);
  }
  syncDatasetFiles() {
    const dir = path.join(this.dataDir, 'datasets');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const row of this.db.prepare('SELECT id,variables FROM environments').all()) {
      const file = path.join(dir, `${row.id}.json`);
      atomicWrite(file, row.variables); fs.chmodSync(file, 0o600);
    }
  }
  deleteEnvironment(projectId, id) {
    this.environment(id, projectId);
    if (this.get(`defaultEnvironment:${projectId}`) === id) throw new ApiError(409, 'Dataset default đang được dùng cho môi trường Mặc định. Bạn có thể sửa các giá trị trong dataset.');
    this.db.prepare('DELETE FROM environments WHERE id=?').run(id);
    fs.rmSync(path.join(this.dataDir, 'datasets', `${id}.json`), { force: true });
    this.touch(); this.writeManifest();
  }
  selectedScripts(projectId, ids, all = false) {
    const scripts = this.scripts(projectId);
    if (all) return scripts;
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string')) throw new ApiError(400, 'Hãy chọn từ 1–500 test script hoặc All.');
    return [...new Set(ids)].map(id => {
      const script = scripts.find(s => s.id === id);
      if (!script) throw new ApiError(400, 'Lựa chọn chứa script không thuộc project.');
      return script;
    });
  }
  copyScripts(sourceId, destinationId, ids, overwriteHashes = {}, transform = source => source) {
    if (sourceId === destinationId) throw new ApiError(400, 'Hãy chọn project đích khác project nguồn.');
    this.project(destinationId);
    const scripts = this.selectedScripts(sourceId, ids);
    const conflicts = [], copies = [];
    for (const script of scripts) {
      try {
        const target = this.target(destinationId, script.filename, overwriteHashes[script.id]);
        const source = transform(fs.readFileSync(this.scriptPath(script), 'utf8'), target.file);
        copies.push({ script, target, source, original: fs.existsSync(target.file) ? fs.readFileSync(target.file) : null });
      } catch (error) {
        if (error.details?.code === 'OVERWRITE_REQUIRED') conflicts.push({ scriptId: script.id, ...error.details });
        else throw error;
      }
    }
    if (conflicts.length) throw new ApiError(409, 'Có file trùng tên trong project đích. Xác nhận trước khi ghi đè.', { code: 'COPY_OVERWRITE_REQUIRED', conflicts });
    this.db.exec('BEGIN IMMEDIATE');
    const written = [];
    try {
      const result = copies.map(copy => {
        written.push(copy);
        return this.saveScript(copy.target, copy.script.name, copy.script.url, copy.source);
      });
      this.db.exec('COMMIT'); return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      for (const copy of written) {
        if (copy.original) atomicWrite(copy.target.file, copy.original);
        else fs.rmSync(copy.target.file, { force: true });
      }
      throw error;
    }
  }
  cloneProject(sourceId, payload, transform = source => source) {
    const source = this.project(sourceId);
    const scripts = this.scripts(sourceId).map(script => ({ ...script, source: fs.readFileSync(this.scriptPath(script), 'utf8') }));
    const environments = payload.copyDatasets === false ? [] : this.environments(sourceId).map(e => this.environment(e.id, sourceId));
    let project;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      project = this.createProject({ name: payload.name, url: source.url });
      for (const script of scripts) {
        const target = this.target(project.id, script.filename);
        this.saveScript(target, script.name, script.url, transform(script.source, target.file));
      }
      for (const environment of environments) {
        const copied = this.saveEnvironment(project.id, { name: environment.name, variables: environment.variables });
        if (this.get(`defaultEnvironment:${sourceId}`) === environment.id) this.set(`defaultEnvironment:${project.id}`, copied.id);
      }
      this.writeManifest();
      this.db.exec('COMMIT'); return project;
    } catch (error) {
      const datasetIds = project ? this.environments(project.id).map(e => e.id) : [];
      this.db.exec('ROLLBACK');
      if (project) fs.rmSync(path.join(this.scriptsDir, project.id), { recursive: true, force: true });
      for (const id of datasetIds) fs.rmSync(path.join(this.dataDir, 'datasets', `${id}.json`), { force: true });
      this.writeManifest(); throw error;
    }
  }
  target(projectId, name, overwriteHash) {
    this.project(projectId);
    const filename = scriptFilename(name);
    const existing = this.db.prepare('SELECT * FROM scripts WHERE projectId=? AND fileKey=?').get(projectId, fileKey(filename));
    const file = path.join(this.projectDir(projectId), existing?.filename || filename);
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new ApiError(400, 'Đích ghi không phải file thông thường.');
    const currentHash = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
    if (currentHash && overwriteHash !== currentHash) {
      throw new ApiError(409, `File “${existing?.filename || filename}” đã tồn tại trong project. Bạn có muốn ghi đè?`,
        { code: 'OVERWRITE_REQUIRED', filename: existing?.filename || filename, overwriteHash: currentHash });
    }
    return { projectId, filename: existing?.filename || filename, existing, file, originalHash: currentHash };
  }
  saveScript(target, name, url, source) {
    const currentHash = fs.existsSync(target.file) ? hash(fs.readFileSync(target.file)) : null;
    if (currentHash !== target.originalHash) throw new ApiError(409, 'File đã thay đổi trong lúc ghi thao tác. File tạm được giữ lại; file hiện tại chưa bị ghi đè.');
    const now = new Date().toISOString();
    const script = { id: target.existing?.id || randomUUID(), projectId: target.projectId, name, filename: target.filename,
      url, createdAt: target.existing?.createdAt || now, updatedAt: now, hash: hash(source), revision: this.touch() };
    atomicWrite(target.file, source);
    this.db.prepare(`INSERT INTO scripts VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,url=excluded.url,updatedAt=excluded.updatedAt,hash=excluded.hash,revision=excluded.revision`)
      .run(script.id, script.projectId, name, script.filename, fileKey(script.filename), url, script.createdAt, now, script.hash, script.revision);
    return script;
  }
  deleteScript(id) {
    const script = this.script(id);
    const file = this.scriptPath(script);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.db.prepare('DELETE FROM scripts WHERE id=?').run(id);
    this.touch();
  }
  deleteProject(id) {
    this.project(id);
    const dir = this.projectDir(id);
    if (fs.readdirSync(dir).length) throw new ApiError(409, 'Hãy xóa các test script trong project trước.');
    const environments = this.environments(id);
    this.db.prepare('DELETE FROM scripts WHERE projectId=?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    fs.rmdirSync(dir);
    for (const e of environments) fs.rmSync(path.join(this.dataDir, 'datasets', `${e.id}.json`), { force: true });
    this.touch(); this.writeManifest();
  }
  backedUpRevision() {
    const archive = Number(this.get('backupRevision'));
    return this.localScriptsDir ? Math.min(archive, Number(this.get('localRevision'))) : archive;
  }
  backupStatus() { return { pending: Number(this.get('revision')) > this.backedUpRevision(), at: this.get('backupAt'), error: this.get('backupError') }; }
  localProjectFolder(project) {
    const key = `localFolder:${project.id}`;
    const existing = this.get(key);
    if (existing) return existing;
    const used = new Set(this.db.prepare("SELECT value FROM settings WHERE key LIKE 'localFolder:%'").all().map(row => fileKey(row.value)));
    const base = projectFolderName(project.name);
    let folder = base;
    if (used.has(fileKey(folder)) || fs.existsSync(path.join(this.localScriptsDir, folder))) folder = `${base}-${project.id}`;
    this.set(key, folder);
    return folder;
  }
  syncLocalScripts(snapshot, projects) {
    if (!this.localScriptsDir) return;
    fs.mkdirSync(this.localScriptsDir, { recursive: true });
    if (!fs.lstatSync(this.localScriptsDir).isDirectory()) throw new Error('Thư mục bản sao local không hợp lệ.');
    for (const project of projects) {
      const directory = path.join(this.localScriptsDir, project.localFolder);
      fs.mkdirSync(directory, { recursive: true });
      if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Thư mục local của ${project.name} không hợp lệ.`);
      for (const filename of fs.readdirSync(path.join(snapshot, 'tests-scripts', project.id))) {
        const file = path.join(directory, filename);
        if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error(`File local ${filename} không hợp lệ.`);
        atomicWrite(file, fs.readFileSync(path.join(snapshot, 'tests-scripts', project.id, filename)));
      }
    }
    // Retain files from deleted scripts/projects as backups. Never prune the user's local directory.
  }
  backup() {
    let revision = Number(this.get('revision'));
    const snapshotId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const staging = path.join(this.backupDir, `.pending-${snapshotId}`);
    try {
      this.reconcile();
      revision = Number(this.get('revision'));
      const projects = this.projects().map(project => ({ ...project, localFolder: this.localScriptsDir ? this.localProjectFolder(project) : undefined }));
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      const files = [];
      for (const project of projects) {
        const dest = path.join(staging, 'tests-scripts', project.id);
        fs.mkdirSync(dest, { recursive: true });
        for (const script of this.scripts(project.id)) {
          const source = this.scriptPath(script);
          if (!fs.existsSync(source)) throw new Error(`Thiếu file ${script.filename}; chưa tạo snapshot mới.`);
          const content = fs.readFileSync(source);
          fs.writeFileSync(path.join(dest, script.filename), content);
          files.push({ projectId: project.id, filename: script.filename, sha256: hash(content) });
        }
      }
      fs.copyFileSync(path.join(this.dataDir, 'projects.json'), path.join(staging, 'projects.json'));
      this.syncDatasetFiles();
      fs.cpSync(path.join(this.dataDir, 'datasets'), path.join(staging, 'datasets'), { recursive: true });
      this.db.prepare('VACUUM INTO ?').run(path.join(staging, 'studio.sqlite'));
      fs.chmodSync(path.join(staging, 'studio.sqlite'), 0o600);
      fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({ snapshotId, revision, createdAt: new Date().toISOString(), projects, files }, null, 2));
      const completed = path.join(this.backupDir, snapshotId);
      fs.renameSync(staging, completed);
      this.syncLocalScripts(completed, projects);
      this.set('backupRevision', revision);
      if (this.localScriptsDir) this.set('localRevision', revision);
      this.set('backupAt', new Date().toISOString()); this.set('backupError', '');
    } catch (error) {
      this.set('backupError', error.message);
      // Only this incomplete snapshot is removed; completed versions are immutable.
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* Retry can use a fresh staging directory. */ }
    }
    return this.backupStatus();
  }
  close() { this.db.close(); }
}

module.exports = { StudioStore, ApiError, scriptFilename, hash, atomicWrite };
