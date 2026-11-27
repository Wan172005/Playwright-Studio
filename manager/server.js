'use strict';
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { StudioStore, ApiError, scriptFilename, hash } = require('./store');
const { prepareSource } = require('./script-source');
const { parameterizeRecording } = require('./recording-data');
const { runtimeProjectName } = require('./project-runtime');
const { parseEnv } = require('node:util');

function normalizeUrl(value, optional = false) {
  let candidate = String(value || '').trim();
  if (!candidate && optional) return '';
  if (!candidate) throw new ApiError(400, 'Vui lòng nhập Website URL.');
  if (!/^https?:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  let url;
  try { url = new URL(candidate); } catch { throw new ApiError(400, 'Website URL không hợp lệ.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new ApiError(400, 'Chỉ dùng HTTP/HTTPS và không nhập mật khẩu trong URL.');
  return url.toString();
}
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readJson(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new ApiError(415, 'Cần gửi application/json.');
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 768 * 1024) throw new ApiError(413, 'Request quá lớn.');
  }
  try { return JSON.parse(raw || '{}'); } catch { throw new ApiError(400, 'JSON không hợp lệ.'); }
}
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function createStudioServer(options = {}) {
  const root = options.root || path.resolve(__dirname, '..');
  const dataDir = options.dataDir || process.env.STUDIO_DATA_DIR || path.join(root, '.studio');
  const scriptsDir = options.scriptsDir || process.env.SCRIPTS_DIR || path.join(dataDir, 'scripts');
  const localScriptsDir = options.localScriptsDir || process.env.LOCAL_SCRIPTS_DIR || path.join(root, 'tests-scripts');
  const backupDir = options.backupDir || process.env.BACKUP_DIR || path.resolve(root, '..', 'playwright-studio-backups');
  const cli = options.cli || path.join(root, 'node_modules/playwright/cli.js');
  const uiPort = options.uiPort || Number(process.env.UI_MODE_PORT || 9323);
  const store = new StudioStore({ dataDir, scriptsDir, backupDir, localScriptsDir });
  if (store.projects().length && store.backupStatus().pending) store.backup();
  const draftsDir = path.join(dataDir, 'drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  const state = { session: null, message: 'Sẵn sàng.', logs: [], ui: null };
  const selections = new Map();
  const runtimeFile = path.join(root, 'manager/runtime/dataset.ts');
  const prepare = (source, filename, settings = {}) => prepareSource(source, { filename, runtimeFile, ...settings });
  function log(message) {
    state.logs.push(`${new Date().toISOString()} ${message}`);
    state.logs = state.logs.slice(-80);
    console.log(message);
  }
  function output(child, label) {
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', data => log(`[${label}] ${String(data).trim()}`));
  }
  function snapshot(projectId) {
    if (store.reconcile() && !state.session) store.backup();
    return { projects: store.projects(), scripts: projectId ? store.scripts(projectId) : [], environments: projectId ? store.environments(projectId) : [], defaultEnvironmentId: projectId ? store.get(`defaultEnvironment:${projectId}`) : '',
      session: state.session && { id: state.session.id, projectId: state.session.target.projectId, name: state.session.name,
        filename: state.session.target.filename, stopping: state.session.stopping },
      message: state.message, backup: store.backupStatus(), logs: state.logs,
      desktopUrl: `http://localhost:${process.env.NOVNC_PUBLIC_PORT || '6080'}/vnc.html?autoconnect=true&resize=scale` };
  }
  function ensureIdle() { if (state.session) throw new ApiError(409, 'Hãy dừng và lưu phiên ghi thao tác hiện tại trước.'); }
  function finalize(session, code, signal) {
    if (session.finalized) return;
    session.finalized = true;
    try {
      if (session.cancelled || (!session.stopping && code !== 0) || session.forced ||
          (session.stopping && ![0, 130].includes(code) && signal !== 'SIGINT')) {
        throw new Error('Phiên ghi chưa hoàn tất. File cũ được giữ nguyên; bản nháp còn trong thư mục drafts.');
      }
      if (!fs.existsSync(session.draft) || !fs.statSync(session.draft).size) throw new Error('Chưa tạo được nội dung test script.');
      let source = fs.readFileSync(session.draft, 'utf8');
      if (!/\btest\(/.test(source)) throw new Error('Bản nháp chưa chứa test Playwright hợp lệ.');
      source = source.replace(/\btest\(\s*(['"])test\1\s*,/, () => `test(${JSON.stringify(session.name)},`);
      const environment = store.environment(session.environmentId, session.target.projectId);
      const recorded = parameterizeRecording(source, { filename: session.target.file, runtimeFile, baseUrl: session.url }, environment.variables);
      source = recorded.source;
      // A completed snapshot must preserve the previous version before replacing it.
      if (store.backup().error) throw new Error('Chưa sao lưu được dữ liệu cũ. Giữ nguyên file cũ và bản nháp; hãy kiểm tra thư mục backup.');
      store.saveRecordedScript(session.target, session.name, session.url, source, session.environmentId, recorded.variables);
      fs.unlinkSync(session.draft);
      const backup = store.backup();
      state.message = backup.pending ? `Đã lưu ${session.target.filename}; chưa sao lưu được. Hãy thử lại.` : `Đã lưu và sao lưu ${session.target.filename}.`;
    } catch (error) { state.message = error.message; log(error.message); }
    finally { if (state.session === session) state.session = null; }
  }
  function startSession(payload) {
    ensureIdle();
    if (!payload.projectId) throw new ApiError(400, 'Bạn cần tạo và chọn project trước khi tạo test script.');
    const filename = scriptFilename(payload.name);
    const target = store.target(payload.projectId, payload.name, payload.overwriteHash);
    const url = normalizeUrl(payload.url);
    if (!fs.existsSync(cli)) throw new ApiError(503, 'Chưa cài Playwright. Hãy khởi động bằng Docker Compose.');
    const environment = store.recordingEnvironment(payload.projectId, payload.environmentId, url);
    if (!store.project(payload.projectId).url) {
      store.db.prepare('UPDATE projects SET url=? WHERE id=?').run(new URL(url).origin, payload.projectId);
      store.touch(); store.writeManifest();
    }
    const id = randomUUID();
    const draft = path.join(draftsDir, `${id}.spec.ts`);
    const child = spawn(process.execPath, [cli, 'codegen', '--target=playwright-test', '--browser=chromium', '--output', draft, url],
      { cwd: root, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const session = { id, target, draft, child, environmentId: environment.id, name: String(payload.name).replace(/\.spec\.ts$|\.ts$/, ''), url, stopping: false };
    state.session = session;
    state.message = `Đang ghi thao tác cho ${filename}.`;
    output(child, 'codegen');
    child.on('error', error => { session.cancelled = true; log(error.message); finalize(session, 1); });
    child.on('close', (code, signal) => finalize(session, code, signal));
    return snapshot(payload.projectId);
  }
  function stopSession() {
    const session = state.session;
    if (!session) throw new ApiError(409, 'Hiện không có phiên ghi thao tác.');
    if (!session.stopping) {
      session.stopping = true;
      session.child.kill('SIGINT');
      setTimeout(() => { if (!session.finalized) { session.forced = true; session.child.kill('SIGTERM'); } }, 12000).unref();
    }
    return { stopping: true };
  }
  function uiUrl(id, environmentId) {
    ensureIdle();
    const script = store.script(id), project = store.project(script.projectId), file = store.scriptPath(script);
    if (!fs.existsSync(file)) throw new ApiError(404, 'Không tìm thấy file test script trong volume.');
    const environment = environmentId ? store.environment(environmentId, project.id) : null;
    const params = new URLSearchParams({ project: runtimeProjectName(project, environment), arg: `^${escapeRegex(file)}$`, studioFile: script.filename,
      studioProject: project.name, studioRun: '1' });
    return `/playwright/?${params}`;
  }
  function groupUiUrl(projectId, payload) {
    ensureIdle();
    const project = store.project(projectId);
    const scripts = store.selectedScripts(projectId, payload.scriptIds, payload.all === true);
    if (!scripts.length) throw new ApiError(400, 'Project chưa có test script.');
    for (const script of scripts) if (!fs.existsSync(store.scriptPath(script))) throw new ApiError(404, `Thiếu file ${script.filename}.`);
    const environment = payload.environmentId ? store.environment(payload.environmentId, projectId) : null;
    const selection = randomUUID();
    const params = new URLSearchParams({ project: runtimeProjectName(project, environment), studioSelection: selection,
      studioProject: project.name, studioRun: '1', workers: '1' });
    if (payload.all !== true) params.set('arg', `^${escapeRegex(store.projectDir(projectId))}/(?:${scripts.map(s => escapeRegex(s.filename)).join('|')})$`);
    const url = `/playwright/?${params}`;
    if (url.length > 12000) throw new ApiError(400, 'Lựa chọn quá lớn. Chọn All hoặc chia thành nhóm nhỏ hơn.');
    selections.set(selection, { files: scripts.map(s => s.filename), project: project.name, environment: environment?.name || 'Mặc định' });
    if (selections.size > 200) selections.delete(selections.keys().next().value);
    return url;
  }
  function proxy(req, res) {
    const upstreamPath = req.url.slice('/playwright'.length) || '/';
    const upstream = http.request({ hostname: '127.0.0.1', port: uiPort, path: upstreamPath, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${uiPort}`, 'accept-encoding': 'identity' } }, response => {
      const headers = { ...response.headers, 'cache-control': 'no-store' };
      if (headers.location) {
        const location = new URL(headers.location, `http://127.0.0.1:${uiPort}${upstreamPath}`);
        // Playwright's root redirect contains a per-process prefix. Preserve the Manager's selection through it.
        if (upstreamPath.split('?')[0] === '/') {
          for (const [key, value] of new URL(upstreamPath, 'http://localhost').searchParams) location.searchParams.append(key, value);
        }
        headers.location = `/playwright${location.pathname}${location.search}`;
      }
      if (String(headers['content-type']).includes('text/html') && upstreamPath.split('?')[0].endsWith('/uiMode.html')) {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const html = Buffer.concat(chunks).toString().replace('</head>', '<script defer src="./studio-bridge.js"></script></head>');
          delete headers['content-length']; delete headers['content-encoding'];
          res.writeHead(response.statusCode, headers); res.end(html);
        });
      } else { res.writeHead(response.statusCode, headers); response.pipe(res); }
    });
    upstream.on('error', () => { if (!res.headersSent) json(res, 503, { error: 'Playwright UI đang khởi động. Vui lòng thử lại.' }); else res.destroy(); });
    req.pipe(upstream);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (req.method === 'GET' && /^\/playwright\/[a-zA-Z0-9-]+\/trace\/studio-selection\.json$/.test(url.pathname)) {
        const selection = selections.get(url.searchParams.get('id'));
        if (!selection) throw new ApiError(404, 'Lựa chọn đã hết hạn. Hãy mở lại từ Manager.');
        return json(res, 200, selection);
      }
      // Keep the bridge within the trace service worker's scope; out-of-scope subresources are treated as trace snapshots.
      if (req.method === 'GET' && /^\/playwright\/[a-zA-Z0-9-]+\/trace\/studio-bridge\.js$/.test(url.pathname)) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(root, 'manager/public/ui-bridge.js')));
      }
      if (url.pathname.startsWith('/playwright/')) return proxy(req, res);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new ApiError(403, 'Origin không hợp lệ.');
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot(url.searchParams.get('projectId')));
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        ensureIdle(); const body = await readJson(req);
        const project = store.createProject({ ...body, url: normalizeUrl(body.url, true) }); store.backup();
        return json(res, 201, { project });
      }
      if (req.method === 'POST' && url.pathname === '/api/scripts/start') return json(res, 200, startSession(await readJson(req)));
      if (req.method === 'POST' && url.pathname === '/api/scripts/stop') { await readJson(req); return json(res, 200, stopSession()); }
      if (req.method === 'POST' && url.pathname === '/api/backup') { ensureIdle(); await readJson(req); return json(res, 200, store.backup()); }
      if (req.method === 'POST' && url.pathname === '/api/datasets/parse') {
        const body = await readJson(req);
        if (typeof body.envText !== 'string' || Buffer.byteLength(body.envText) > 128 * 1024) throw new ApiError(400, 'File .env quá lớn.');
        const variables = parseEnv(body.envText);
        if (Object.keys(variables).length > 200) throw new ApiError(400, 'Dataset cần tối đa 200 biến.');
        if (!Object.keys(variables).length && body.envText.trim()) throw new ApiError(400, 'File .env không có biến hợp lệ.');
        return json(res, 200, { variables });
      }
      const projectAction = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)\/(open-ui|copy-scripts|clone|rename|environments)(?:\/([a-f0-9-]+)(?:\/(env))?)?$/);
      if (projectAction) {
        const [, projectId, action, environmentId, format] = projectAction;
        if (action === 'environments' && environmentId && req.method === 'GET') {
          const environment = store.environment(environmentId, projectId);
          if (format === 'env') {
            const content = Object.entries(environment.variables).map(([key, value]) => {
              for (const quote of ["'", '`', '"', '']) {
                const line = `${key}=${quote}${value}${quote}`;
                if (parseEnv(line)[key] === value) return line;
              }
              throw new ApiError(400, `Biến ${key} chứa tổ hợp dấu nháy không thể xuất thành .env. Có thể chỉnh giá trị trong Manager.`);
            }).join('\n') + '\n';
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="dataset.env"` });
            return res.end(content);
          }
          return json(res, 200, environment);
        }
        if (action === 'environments' && environmentId && req.method === 'DELETE') {
          ensureIdle(); if (store.backup().error) throw new ApiError(409, 'Cần sao lưu thành công trước khi xóa môi trường.');
          store.deleteEnvironment(projectId, environmentId); store.backup(); return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && !environmentId) {
          ensureIdle(); const body = await readJson(req);
          if (action === 'rename') {
            if (typeof body.expectedName !== 'string') throw new ApiError(400, 'Thiếu tên project hiện tại. Hãy tải lại trang.');
            store.project(projectId);
            if (store.backup().error) throw new ApiError(409, 'Cần sao lưu thành công trước khi đổi tên project.');
            const project = store.renameProject(projectId, body);
            return json(res, 200, { project, backup: store.backup() });
          }
          if (action === 'open-ui') return json(res, 200, { url: groupUiUrl(projectId, body) });
          if (action === 'environments') {
            const environment = store.saveEnvironment(projectId, body); store.backup(); return json(res, 200, { environment });
          }
          if (action === 'clone') {
            const project = store.cloneProject(projectId, body, (source, file) => prepare(source, file, { rebaseOnly: true }));
            store.backup(); return json(res, 201, { project });
          }
          if (action === 'copy-scripts') {
            if (store.backup().error) throw new ApiError(409, 'Cần sao lưu thành công trước khi copy.');
            const copied = store.copyScripts(projectId, body.targetProjectId, body.scriptIds, body.overwriteHashes || {}, (source, file) => prepare(source, file, { rebaseOnly: true }));
            store.backup(); return json(res, 200, { scripts: copied });
          }
        }
      }
      const match = url.pathname.match(/^\/api\/scripts\/([a-f0-9-]+)(?:\/(source|open-ui|download|prepare))?$/);
      if (match) {
        const [, id, action] = match;
        if (req.method === 'POST' && action === 'open-ui') { const body = await readJson(req); return json(res, 200, { url: uiUrl(id, body.environmentId) }); }
        if (req.method === 'POST' && ['source', 'prepare'].includes(action)) {
          ensureIdle(); const body = await readJson(req), script = store.script(id), file = store.scriptPath(script);
          const source = prepare(body.source, file, { baseUrl: script.url || store.project(script.projectId).url, convertUrls: body.convertUrls === true });
          if (action === 'prepare') return json(res, 200, { source });
          if (typeof body.expectedHash !== 'string') throw new ApiError(400, 'Thiếu phiên bản script. Hãy tải lại nội dung.');
          if (body.expectedHash !== hash(fs.readFileSync(file))) throw new ApiError(409, 'Script đã thay đổi sau khi bạn mở trình sửa. Hãy tải lại nội dung trước khi lưu.');
          const target = store.target(script.projectId, script.filename, body.expectedHash);
          if (store.backup().error) throw new ApiError(409, 'Cần sao lưu thành công trước khi sửa script.');
          const saved = store.saveScript(target, script.name, script.url, source); store.backup();
          return json(res, 200, { ...saved, source });
        }
        if (req.method === 'GET' && ['source', 'download'].includes(action)) {
          const script = store.script(id), file = store.scriptPath(script);
          if (!fs.existsSync(file)) throw new ApiError(404, 'Không tìm thấy file.');
          if (action === 'source') { const source = fs.readFileSync(file, 'utf8'); return json(res, 200, { ...script, source, hash: hash(source) }); }
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(script.filename)}` });
          return fs.createReadStream(file).pipe(res);
        }
        if (req.method === 'DELETE' && !action) {
          ensureIdle();
          const script = store.script(id);
          if (fs.existsSync(store.scriptPath(script)) && store.backup().error) throw new ApiError(409, 'Cần sao lưu thành công trước khi xóa test script.');
          store.deleteScript(id); store.backup(); return json(res, 200, { ok: true });
        }
      }
      const projectMatch = url.pathname.match(/^\/api\/projects\/([a-f0-9-]+)$/);
      if (req.method === 'DELETE' && projectMatch) {
        ensureIdle(); if (store.backup().error) throw new ApiError(409, 'Cần sao lưu thành công trước khi xóa project.');
        store.deleteProject(projectMatch[1]); store.backup(); return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && ['/', '/index.html', '/styles.css', '/app.js', '/ui-bridge.js'].includes(url.pathname)) {
        const file = path.join(root, 'manager/public', url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript' };
        res.writeHead(200, { 'Content-Type': `${types[path.extname(file)]}; charset=utf-8`, 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      json(res, 404, { error: 'Không tìm thấy tài nguyên.' });
    } catch (error) { json(res, error.status || 500, { error: error.message, ...error.details }); }
  });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/playwright/')) return socket.destroy();
    const upstream = net.connect(uiPort, '127.0.0.1', () => {
      const headers = { ...req.headers, host: `127.0.0.1:${uiPort}` };
      upstream.write(`${req.method} ${req.url.slice('/playwright'.length)} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  const retry = setInterval(() => { if (!state.session && store.projects().length && store.backupStatus().pending) store.backup(); }, 60000);
  retry.unref();
  function startUi() {
    const child = spawn(process.execPath, [cli, 'test', '--ui-host=0.0.0.0', `--ui-port=${uiPort}`], {
      cwd: root, env: { ...process.env, STUDIO_DATA_DIR: dataDir, SCRIPTS_DIR: scriptsDir,
        STUDIO_ARTIFACTS_DIR: options.artifactsDir || process.env.STUDIO_ARTIFACTS_DIR || root,
        DISPLAY: process.env.DISPLAY || ':99' }, stdio: ['ignore', 'pipe', 'pipe'] });
    state.ui = child; output(child, 'playwright-ui'); child.on('error', error => log(error.message));
    child.on('exit', code => { state.ui = null; log(`Playwright UI đã dừng (${code}).`); });
    return child;
  }
  function close() {
    clearInterval(retry);
    if (state.session) { state.session.cancelled = true; state.session.child.kill('SIGTERM'); }
    state.ui?.kill('SIGTERM'); server.close(); server.closeAllConnections();
  }
  return { server, store, state, startUi, close, startSession, stopSession, uiUrl };
}
if (require.main === module) {
  const app = createStudioServer();
  app.server.listen(Number(process.env.MANAGER_PORT || 8080), '0.0.0.0', () => { console.log('Playwright Studio manager ready.'); app.startUi(); });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { app.close(); setTimeout(() => process.exit(0), 500).unref(); });
}
module.exports = { createStudioServer, normalizeUrl, escapeRegex };
