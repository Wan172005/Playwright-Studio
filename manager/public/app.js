'use strict';
const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let selectedId = localStorage.getItem('studio.project') || '';
let snapshot = { projects: [], scripts: [], backup: {}, session: null };
let drawerProjectId = '';
let drawerEnvironmentId = '';
let refreshing = false;
let toastTimer;
let lastMessage = '';
const selectedScripts = new Set();
let selectedEnvironmentId = localStorage.getItem(`studio.environment.${selectedId}`) || '';
let currentSource = null;
let recordingTab = null;
let copyIds = [];
let editingEnvironment = null;
let renamingProject = null;
const renderedHtml = new WeakMap();
async function api(url, method = 'GET', body = {}) {
  const response = await fetch(`/api${url}`, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Không thể thực hiện thao tác.'), result);
  return result;
}
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}
function confirmAction(title, message, label = 'Xác nhận') {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-accept').textContent = label;
  return new Promise(resolve => {
    let settled = false;
    const settle = value => { if (settled) return; settled = true; dialog.close(); resolve(value); };
    $('confirm-accept').onclick = () => settle(true);
    $('confirm-cancel').onclick = () => settle(false);
    dialog.oncancel = event => { event.preventDefault(); settle(false); };
    dialog.showModal();
  });
}
function selectProject(id) {
  selectedId = id; localStorage.setItem('studio.project', id);
  selectedScripts.clear(); selectedEnvironmentId = localStorage.getItem(`studio.environment.${id}`) || '';
  $('search').value = ''; closeDrawers(); refresh();
}
function closeDrawers() { $('script-drawer').hidden = true; $('source-drawer').hidden = true; }
function project() { return snapshot.projects.find(p => p.id === selectedId); }
function relativeDate(value) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'Vừa xong';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} phút trước`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} giờ trước`;
  return new Date(value).toLocaleDateString('vi-VN');
}
function setHtml(element, value) {
  // Compare rendered data, not live DOM: opening <details> adds an `open` attribute.
  if (renderedHtml.get(element) !== value) {
    element.innerHTML = value;
    renderedHtml.set(element, value);
  }
}
function renderScripts() {
  const query = $('search').value.toLocaleLowerCase('vi');
  let scripts = snapshot.scripts.filter(s => `${s.name} ${s.filename}`.toLocaleLowerCase('vi').includes(query));
  if ($('sort').value === 'name') scripts = [...scripts].sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  $('script-count').textContent = snapshot.scripts.length;
  const disabled = snapshot.session ? 'disabled' : '';
  const html = scripts.map(script => `<tr data-script-id="${script.id}">
    <td class="select-cell"><input type="checkbox" data-select-id="${script.id}" aria-label="Chọn ${esc(script.filename)}" ${selectedScripts.has(script.id) ? 'checked' : ''}></td>
    <td><button class="script-title" data-action="source" data-id="${script.id}">${esc(script.name)}</button><span class="filename">${esc(script.filename)}</span></td>
    <td class="date-cell" title="${esc(new Date(script.updatedAt).toLocaleString('vi-VN'))}">${relativeDate(script.updatedAt)}</td>
    <td class="backup-cell"><span>${script.backupStatus === 'saved' ? `<span class="good">${icon('check')}</span>Đã sao lưu` : '<span class="pending">Chưa sao lưu</span>'}</span></td>
    <td><div class="row-actions"><button data-action="run" data-id="${script.id}" ${disabled} ${script.exists ? '' : 'disabled'}>${icon('play')}Chạy trong UI</button>
    <details><summary aria-label="Thao tác với ${esc(script.filename)}">···</summary><div class="menu"><button data-action="source" data-id="${script.id}">Xem nội dung</button><a href="/api/scripts/${script.id}/download">Tải file .ts</a><button data-action="copy" data-id="${script.id}" ${disabled}>Copy sang project</button><button data-action="overwrite" data-id="${script.id}" ${disabled}>Ghi lại script</button><button data-action="delete" data-id="${script.id}" class="delete" ${disabled}>Xóa test script</button></div></details></div></td></tr>`).join('');
  const checkboxFocus = document.activeElement?.dataset.selectId;
  const openMenu = $('scripts').querySelector('details[open]');
  const openId = openMenu?.closest('tr').dataset.scriptId;
  const focused = openMenu?.contains(document.activeElement) ? document.activeElement : null;
  const focusedAction = focused?.dataset.action;
  const focusedDownload = focused?.matches('a');
  setHtml($('scripts'), html);
  // Real data changes (including relative dates) may replace the rows. Keep the user's menu and focus.
  if (openId) {
    const menu = $('scripts').querySelector(`tr[data-script-id="${openId}"] details`);
    if (menu) {
      menu.open = true;
      if (focused && !focused.isConnected) {
        const selector = focusedAction ? `[data-action="${focusedAction}"]` : focusedDownload ? 'a' : 'summary';
        menu.querySelector(selector)?.focus({ preventScroll: true });
      }
    }
  }
  if (checkboxFocus) $('scripts').querySelector(`[data-select-id="${checkboxFocus}"]`)?.focus({ preventScroll: true });
  renderSelection();
  $('scripts-empty').hidden = scripts.length > 0;
  $('scripts-empty').textContent = query ? 'Không tìm thấy test script phù hợp.' : 'Chưa có test script. Chọn “Tạo test script” để bắt đầu.';
}
function render() {
  const current = project();
  $('onboarding').hidden = Boolean(current);
  $('project-view').hidden = !current;
  $('delete-project').hidden = !current;
  $('clone-project').hidden = !current;
  $('rename-project').hidden = !current;
  $('rename-project').disabled = Boolean(snapshot.session);
  $('clone-project').disabled = Boolean(snapshot.session);
  for (const id of selectedScripts) if (!snapshot.scripts.some(s => s.id === id)) selectedScripts.delete(id);
  renderEnvironments();
  $('delete-project').disabled = Boolean(snapshot.session);
  setHtml($('projects'), snapshot.projects.length ? snapshot.projects.map(p => `<button class="project-item ${p.id === selectedId ? 'selected' : ''}" data-project="${p.id}" title="${esc(p.name)}" ${p.id === selectedId ? 'aria-current="page"' : ''}>${icon('folder')}<span>${esc(p.name)}</span></button>`).join('') : '<div class="nav-empty">Chưa có project</div>');
  setHtml($('breadcrumb'), current ? `<span>Projects</span> / ${esc(current.name)}` : 'Projects');
  $('breadcrumb').title = current?.name || '';
  if (current) {
    $('project-name').title = current.name;
    $('project-name').textContent = current.name; $('project-url').textContent = current.url ? new URL(current.url).hostname : 'Quản lý test script trong project';
    $('new-script').disabled = Boolean(snapshot.session); renderScripts();
  }
  document.querySelectorAll('[data-action="new-project"]').forEach(button => { button.disabled = Boolean(snapshot.session); });
  $('session-banner').hidden = !snapshot.session;
  if (snapshot.session) {
    $('session-title').textContent = `${snapshot.session.stopping ? 'Đang kết thúc' : snapshot.session.phase === 'paused' ? 'Đã tạm dừng' : 'Đang ghi thao tác'}: ${snapshot.session.filename}`;
    $('session-project').textContent = snapshot.projects.find(p => p.id === snapshot.session.projectId)?.name || '';
    $('desktop-link').href = snapshot.desktopUrl;
    $('stop-script').disabled = snapshot.session.stopping || ['starting', 'paused'].includes(snapshot.session.phase);
  }
  const backup = snapshot.backup;
  const hasProjects = snapshot.projects.length > 0;
  setHtml($('statusbar'), !hasProjects ? `${icon('folder')}Chưa có dữ liệu để sao lưu` : `<span><span class="good">${icon('check')}</span>Đã lưu trong volume</span><span class="separator"></span><span class="${backup.pending || backup.error ? 'pending' : ''}">${backup.pending || backup.error ? 'Chưa sao lưu vào tests-scripts' : `${icon('check')}Đã sao lưu vào tests-scripts`}</span>`);
  $('backup-detail').textContent = backup.at ? `Lần sao lưu gần nhất: ${new Date(backup.at).toLocaleString('vi-VN')}` : 'Chưa có bản sao lưu.';
  $('backup-error').textContent = backup.error ? `Không thể sao lưu: ${backup.error}` : '';
  $('retry-backup').disabled = Boolean(snapshot.session);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const base = await api('/state');
    if (!base.projects.some(p => p.id === selectedId)) {
      selectedId = base.projects[0]?.id || ''; localStorage.setItem('studio.project', selectedId); selectedScripts.clear(); selectedEnvironmentId = localStorage.getItem(`studio.environment.${selectedId}`) || '';
    }
    snapshot = selectedId ? await api(`/state?projectId=${encodeURIComponent(selectedId)}`) : base;
    render();
    if (snapshot.message !== lastMessage) {
      if (lastMessage && snapshot.message !== 'Sẵn sàng.') toast(snapshot.message);
      lastMessage = snapshot.message;
    }
  } catch (error) { $('statusbar').textContent = `Không kết nối được Manager: ${error.message}`; }
  finally { refreshing = false; }
}
function openScript(script) {
  if (!project() || snapshot.session) return;
  closeDrawers(); drawerProjectId = selectedId; drawerEnvironmentId = selectedEnvironmentId;
  $('script-form').reset(); $('script-form').querySelector('.form-error').textContent = '';
  $('script-project').value = project().name;
  $('script-environment').value = (snapshot.environments || []).find(e => e.id === drawerEnvironmentId)?.name || 'Mặc định (dataset default)';
  $('script-name').value = script?.filename || '';
  const recordingEnvironment = (snapshot.environments || []).find(e => e.id === (drawerEnvironmentId || snapshot.defaultEnvironmentId));
  $('script-url').value = script?.url || recordingEnvironment?.baseURL || project().url || '';
  $('script-drawer').hidden = false; filenamePreview(); $('script-name').focus();
}
function filenamePreview() {
  const name = $('script-name').value;
  $('filename-preview').textContent = name ? `File: ${name.endsWith('.ts') ? name : `${name}.spec.ts`}` : 'Tên bạn nhập sẽ được dùng làm tên file.';
}
$('script-name').addEventListener('input', filenamePreview);
$('new-script').onclick = () => openScript();
$('projects').addEventListener('click', event => { const item = event.target.closest('[data-project]'); if (item) selectProject(item.dataset.project); });
document.querySelectorAll('[data-action="new-project"]').forEach(button => { button.onclick = () => { if (!snapshot.projects.length) return $('first-name').focus(); $('project-form').reset(); $('project-form').querySelector('.form-error').textContent = ''; $('project-dialog').showModal(); }; });
document.querySelectorAll('[data-close-drawer]').forEach(button => { button.onclick = closeDrawers; });
document.querySelectorAll('[data-close-source]').forEach(button => { button.onclick = closeDrawers; });
document.querySelectorAll('[data-close-dialog]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) closeDrawers(); });
for (const id of ['first-project-form', 'project-form']) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, button = form.querySelector('[type="submit"]');
    button.disabled = true; form.querySelector('.form-error').textContent = '';
    try {
      const { project: created } = await api('/projects', 'POST', Object.fromEntries(new FormData(form)));
      $('project-dialog').close(); form.reset(); selectedId = created.id; localStorage.setItem('studio.project', selectedId);
      await refresh(); toast(`Đã tạo project ${created.name}.`);
    } catch (error) { form.querySelector('.form-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
}
$('script-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, button = $('start-script');
  const payload = { ...Object.fromEntries(new FormData(form)), projectId: drawerProjectId, environmentId: drawerEnvironmentId };
  button.disabled = true; form.querySelector('.form-error').textContent = '';
  const openDesktopTab = () => {
    const tab = window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    return tab;
  };
  let pendingTab = openDesktopTab();
  try {
    let result;
    try { result = await api('/scripts/start', 'POST', payload); }
    catch (error) {
      if (error.code !== 'OVERWRITE_REQUIRED') throw error;
      pendingTab?.close();
      pendingTab = null;
      const accepted = await confirmAction('Ghi đè test script?', `${error.error}\nBản cũ sẽ được sao lưu trước khi thay thế.`, 'Ghi đè file');
      if (!accepted) return;
      pendingTab = openDesktopTab();
      payload.overwriteHash = error.overwriteHash;
      result = await api('/scripts/start', 'POST', payload);
    }
    closeDrawers(); snapshot = result; render();
    recordingTab = pendingTab?.closed ? null : pendingTab;
    recordingTab?.location.replace(result.desktopUrl);
    toast(recordingTab ? 'Đã mở Browser Desktop.' : 'Bấm Browser Desktop để mở phiên ghi.');
  } catch (error) {
    pendingTab?.close();
    form.querySelector('.form-error').textContent = error.message;
  }
  finally { button.disabled = false; }
});
$('stop-script').onclick = async () => {
  $('stop-script').disabled = true;
  try { await api('/scripts/stop', 'POST'); recordingTab?.close(); await refresh(); } catch (error) { toast(error.message); $('stop-script').disabled = false; }
};
$('search').oninput = renderScripts; $('sort').onchange = renderScripts;
$('scripts').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const { action, id } = button.dataset;
  button.closest('details')?.removeAttribute('open');
  try {
    if (action === 'overwrite') return openScript(snapshot.scripts.find(s => s.id === id));
    if (action === 'run') {
      await openUiTab(`/scripts/${id}/open-ui`, { environmentId: selectedEnvironmentId }, button);
      return;
    }
    if (action === 'copy') return openCopy([id]);
    if (action === 'source') {
      const script = await api(`/scripts/${id}/source`); closeDrawers();
      $('source-title').textContent = script.name; $('source-filename').textContent = script.filename;
      currentSource = script; sourceEditMode(false);
      $('source-code').textContent = script.source; $('download-script').href = `/api/scripts/${id}/download`;
      $('source-drawer').hidden = false; return;
    }
    if (action === 'delete' && await confirmAction('Xóa test script?', `Xóa “${snapshot.scripts.find(s => s.id === id)?.filename}” khỏi project? Các bản backup trước vẫn được giữ.`, 'Xóa test script')) {
      await api(`/scripts/${id}`, 'DELETE'); await refresh(); toast('Đã xóa test script.');
    }
  } catch (error) { toast(error.message); button.disabled = false; }
});
$('delete-project').onclick = async () => {
  if (!project()) return;
  if (snapshot.scripts.length) return toast('Hãy xóa các test script trong project trước.');
  if (await confirmAction('Xóa project?', `Xóa project “${project().name}”? Các bản backup trước vẫn được giữ.`, 'Xóa project')) {
    try { await api(`/projects/${selectedId}`, 'DELETE'); selectedId = ''; await refresh(); } catch (error) { toast(error.message); }
  }
};
$('backup-settings').onclick = () => $('backup-dialog').showModal();
$('retry-backup').onclick = async () => {
  $('retry-backup').disabled = true;
  try { const backup = await api('/backup', 'POST'); toast(backup.error ? 'Sao lưu chưa thành công. Hãy kiểm tra thư mục backup.' : 'Đã sao lưu vào tests-scripts.'); await refresh(); }
  catch (error) { toast(error.message); }
  finally { $('retry-backup').disabled = false; }
};


function renderSelection() {
  const count = selectedScripts.size;
  $('select-all').checked = Boolean(snapshot.scripts.length) && count === snapshot.scripts.length;
  $('select-all').indeterminate = count > 0 && count < snapshot.scripts.length;
  $('select-all').disabled = !snapshot.scripts.length;
  $('selection-count').textContent = count ? `Đã chọn ${count} / ${snapshot.scripts.length} script` : 'Chưa chọn script';
  $('run-selected').disabled = !count || Boolean(snapshot.session);
  $('copy-selected').disabled = !count || Boolean(snapshot.session);
  $('clear-selection').hidden = !count;
}
$('select-all').onchange = () => { selectedScripts.clear(); if ($('select-all').checked) snapshot.scripts.forEach(s => selectedScripts.add(s.id)); renderScripts(); };
$('scripts').addEventListener('change', event => {
  const id = event.target.dataset.selectId; if (!id) return;
  if (event.target.checked) selectedScripts.add(id); else selectedScripts.delete(id);
  renderScripts();
});
$('clear-selection').onclick = () => { selectedScripts.clear(); renderScripts(); };
async function openUiTab(endpoint, payload, button) {
  const tab = window.open('about:blank', '_blank');
  if (!tab) { toast('Trình duyệt đang chặn tab mới. Hãy cho phép cửa sổ bật lên để mở Playwright UI.'); return; }
  tab.opener = null; tab.document.title = 'Đang mở Playwright UI'; tab.document.body.textContent = 'Đang mở Playwright UI…';
  button.disabled = true;
  try { const { url } = await api(endpoint, 'POST', payload); if (!tab.closed) tab.location.replace(url); }
  catch (error) { tab.close(); throw error; }
  finally { button.disabled = Boolean(snapshot.session); }
}
$('run-selected').onclick = async () => {
  try { await openUiTab(`/projects/${selectedId}/open-ui`, { scriptIds: [...selectedScripts], all: selectedScripts.size === snapshot.scripts.length, environmentId: selectedEnvironmentId }, $('run-selected')); }
  catch (error) { toast(error.message); }
  finally { renderSelection(); }
};
function renderEnvironments() {
  const environments = (snapshot.environments || []).filter(e => e.id !== snapshot.defaultEnvironmentId);
  if (selectedEnvironmentId && !environments.some(e => e.id === selectedEnvironmentId)) {
    selectedEnvironmentId = '';
    localStorage.setItem(`studio.environment.${selectedId}`, '');
  }
  setHtml($('run-environment'), '<option value="">Mặc định</option>' + environments.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join(''));
  $('run-environment').value = selectedEnvironmentId;
  $('manage-environments').disabled = Boolean(snapshot.session);
}
$('run-environment').onchange = () => { selectedEnvironmentId = $('run-environment').value; localStorage.setItem(`studio.environment.${selectedId}`, selectedEnvironmentId); };
function openCopy(ids) {
  copyIds = ids;
  $('copy-description').textContent = `Copy ${ids.length} test script từ ${project().name}.`;
  const targets = snapshot.projects.filter(p => p.id !== selectedId);
  $('copy-target').innerHTML = targets.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('copy-form').querySelector('.form-error').textContent = targets.length ? '' : 'Hãy tạo thêm project để làm project đích.';
  $('copy-submit').disabled = !targets.length;
  $('copy-dialog').showModal();
}
$('copy-selected').onclick = () => openCopy([...selectedScripts]);
$('copy-form').onsubmit = async event => {
  event.preventDefault(); $('copy-submit').disabled = true;
  const payload = { scriptIds: copyIds, targetProjectId: $('copy-target').value };
  try {
    try { await api(`/projects/${selectedId}/copy-scripts`, 'POST', payload); }
    catch (error) {
      if (error.code !== 'COPY_OVERWRITE_REQUIRED') throw error;
      if (!await confirmAction('Ghi đè file trong project đích?', error.conflicts.map(c => c.filename).join('\n') + '\nBản cũ sẽ được sao lưu trước khi ghi đè.', 'Ghi đè và copy')) return;
      payload.overwriteHashes = Object.fromEntries(error.conflicts.map(c => [c.scriptId, c.overwriteHash]));
      await api(`/projects/${selectedId}/copy-scripts`, 'POST', payload);
    }
    $('copy-dialog').close(); await refresh(); toast(`Đã copy ${copyIds.length} test script.`);
  } catch (error) { $('copy-form').querySelector('.form-error').textContent = error.message; }
  finally { $('copy-submit').disabled = false; }
};
$('rename-project').onclick = () => {
  renamingProject = { ...project() };
  $('rename-name').value = renamingProject.name;
  $('rename-form').querySelector('.form-error').textContent = '';
  $('rename-dialog').showModal(); $('rename-name').focus(); $('rename-name').select();
};
$('rename-form').onsubmit = async event => {
  event.preventDefault(); const button = $('rename-form').querySelector('[type=submit]'); button.disabled = true;
  try {
    const result = await api(`/projects/${renamingProject.id}/rename`, 'POST', { name: $('rename-name').value, expectedName: renamingProject.name });
    $('rename-dialog').close(); await refresh();
    toast(result.backup.pending ? 'Đã đổi tên project; backup chưa hoàn tất. Kiểm tra Cài đặt sao lưu.' : `Đã đổi tên thành ${result.project.name}.`);
  } catch (error) { $('rename-form').querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('clone-project').onclick = () => {
  $('clone-name').value = `${project().name} copy`; $('clone-datasets').checked = true;
  $('clone-description').textContent = `Sao chép ${snapshot.scripts.length} script sang một project mới.`;
  $('clone-form').querySelector('.form-error').textContent = ''; $('clone-dialog').showModal();
};
$('clone-form').onsubmit = async event => {
  event.preventDefault(); const button = $('clone-form').querySelector('[type=submit]'); button.disabled = true;
  try {
    const result = await api(`/projects/${selectedId}/clone`, 'POST', { name: $('clone-name').value, copyDatasets: $('clone-datasets').checked });
    $('clone-dialog').close(); selectedId = result.project.id; localStorage.setItem('studio.project', selectedId); selectedScripts.clear(); selectedEnvironmentId = '';
    closeDrawers(); await refresh(); toast(`Đã clone project ${result.project.name}.`);
  } catch (error) { $('clone-form').querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
};
function addVariable(key = '', value = '') {
  const row = document.createElement('tr');
  row.innerHTML = `<td><input class="variable-key" aria-label="Tên biến" value="${esc(key)}" placeholder="USERNAME" required></td><td><input class="variable-value" aria-label="Giá trị biến" type="${$('reveal-values').checked || key === 'BASE_URL' ? 'text' : 'password'}" value="${esc(value)}" autocomplete="off"></td><td><button type="button" aria-label="Xóa biến">×</button></td>`;
  row.querySelector('button').onclick = () => row.remove();
  $('dataset-rows').append(row);
}
async function loadEnvironment(id) {
  editingEnvironment = id ? await api(`/projects/${selectedId}/environments/${id}`) : null;
  $('environment-editor-id').value = id || '';
  $('environment-name').value = editingEnvironment?.name || '';
  $('dataset-rows').replaceChildren();
  const variables = editingEnvironment?.variables || { BASE_URL: project().url || '' };
  Object.entries(variables).forEach(([key, value]) => addVariable(key, value));
  $('environment-form').querySelector('.form-error').textContent = '';
  $('delete-environment').hidden = !id; $('export-env').hidden = !id;
  if (id) $('export-env').href = `/api/projects/${selectedId}/environments/${id}/env`;
}
$('manage-environments').onclick = async () => {
  try {
    $('environment-editor-id').innerHTML = '<option value="">Môi trường mới</option>' + (snapshot.environments || []).map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
    $('reveal-values').checked = false; await loadEnvironment(selectedEnvironmentId || snapshot.defaultEnvironmentId); $('environment-dialog').showModal();
  } catch (error) { toast(error.message); }
};
$('environment-editor-id').onchange = async () => { try { await loadEnvironment($('environment-editor-id').value); } catch (error) { toast(error.message); } };
$('new-environment').onclick = () => loadEnvironment('');
$('add-variable').onclick = () => addVariable();
$('reveal-values').onchange = () => {
  $('dataset-rows').querySelectorAll('tr').forEach(row => { row.querySelector('.variable-value').type = $('reveal-values').checked || row.querySelector('.variable-key').value === 'BASE_URL' ? 'text' : 'password'; });
};
$('env-import').onchange = async () => {
  const file = $('env-import').files[0]; if (!file) return;
  try {
    if (file.size > 128 * 1024) throw new Error('File .env quá lớn (tối đa 128 KiB).');
    const result = await api('/datasets/parse', 'POST', { envText: await file.text() });
    $('dataset-rows').replaceChildren(); Object.entries(result.variables).forEach(([key, value]) => addVariable(key, value));
    if (!$('environment-name').value) $('environment-name').value = file.name.replace(/\.env$|\.txt$/i, '') || 'staging';
    $('environment-form').querySelector('.form-error').textContent = '';
  } catch (error) { $('environment-form').querySelector('.form-error').textContent = error.message; }
  finally { $('env-import').value = ''; }
};
$('environment-form').onsubmit = async event => {
  event.preventDefault(); const form = $('environment-form'), button = form.querySelector('[type=submit]'); button.disabled = true;
  try {
    const variables = Object.create(null);
    for (const row of $('dataset-rows').querySelectorAll('tr')) {
      const key = row.querySelector('.variable-key').value.trim();
      if (Object.hasOwn(variables, key)) throw new Error(`Trùng tên biến ${key}.`);
      variables[key] = row.querySelector('.variable-value').value;
    }
    const result = await api(`/projects/${selectedId}/environments`, 'POST', { id: editingEnvironment?.id, expectedUpdatedAt: editingEnvironment?.updatedAt, name: $('environment-name').value, variables });
    selectedEnvironmentId = result.environment.id; localStorage.setItem(`studio.environment.${selectedId}`, selectedEnvironmentId);
    $('environment-dialog').close(); await refresh(); toast('Đã lưu dataset và chọn môi trường chạy.');
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
};
$('delete-environment').onclick = async () => {
  if (!editingEnvironment || !await confirmAction('Xóa môi trường?', `Xóa dataset ${editingEnvironment.name}? Snapshot cũ vẫn được giữ.`, 'Xóa môi trường')) return;
  try {
    await api(`/projects/${selectedId}/environments/${editingEnvironment.id}`, 'DELETE');
    if (selectedEnvironmentId === editingEnvironment.id) selectedEnvironmentId = '';
    $('environment-dialog').close(); await refresh();
  } catch (error) { toast(error.message); }
};
function sourceEditMode(editing) {
  $('source-code').hidden = editing; $('source-editor').hidden = !editing; $('source-edit-tools').hidden = !editing;
  $('edit-source').hidden = editing; $('save-source').hidden = !editing; $('cancel-source-edit').hidden = !editing;
  $('source-error').textContent = '';
  if (editing) $('source-editor').value = currentSource.source;
}
$('edit-source').onclick = async () => {
  if (!currentSource) return;
  sourceEditMode(true);
  try {
    const variables = selectedEnvironmentId ? (await api(`/projects/${selectedId}/environments/${selectedEnvironmentId}`)).variables : { BASE_URL: project().url };
    $('binding-key').innerHTML = [...new Set(['BASE_URL', ...Object.keys(variables)])].map(key => `<option>${esc(key)}</option>`).join('');
  } catch (error) { $('source-error').textContent = error.message; }
};
$('cancel-source-edit').onclick = () => sourceEditMode(false);
$('bind-variable').onclick = () => {
  const editor = $('source-editor'), key = $('binding-key').value, text = editor.value.slice(editor.selectionStart, editor.selectionEnd);
  const quoted = /^(['"`])[\s\S]*\1$/.test(text);
  editor.setRangeText(quoted ? `data(${JSON.stringify(key)})` : `{{${key}}}`, editor.selectionStart, editor.selectionEnd, 'select'); editor.focus();
};
$('prepare-urls').onclick = async () => {
  try { const result = await api(`/scripts/${currentSource.id}/prepare`, 'POST', { source: $('source-editor').value, convertUrls: true }); $('source-editor').value = result.source; }
  catch (error) { $('source-error').textContent = error.message; }
};
$('save-source').onclick = async () => {
  $('save-source').disabled = true;
  try {
    const result = await api(`/scripts/${currentSource.id}/source`, 'POST', { source: $('source-editor').value, expectedHash: currentSource.hash });
    currentSource = result; $('source-code').textContent = result.source; sourceEditMode(false); await refresh(); toast('Đã lưu script và backup.');
  } catch (error) { $('source-error').textContent = error.message; }
  finally { $('save-source').disabled = false; }
};
refresh(); setInterval(refresh, 2000);
