'use strict';

const byId = id => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('session');
const endpoint = '/api/recordings/' + encodeURIComponent(sessionId || '');
const editor = byId('recording-source');
const desktop = byId('recording-desktop');
const statusLabel = byId('recording-status');
const errorLabel = byId('recording-error');
const pauseButton = byId('pause-recording');
const resumeButton = byId('resume-recording');
const saveButton = byId('save-recording');
const cancelButton = byId('cancel-recording');
let view, busy = false, finished = false, version = 0, desktopConnected = false;

async function request(action, payload) {
  const response = await fetch(endpoint + action, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}

function render(next, replaceSource = false) {
  if (next) {
    const updateSource = replaceSource || view?.phase !== 'paused' || next.revision !== view.revision;
    view = next;
    if (updateSource && typeof next.source === 'string' && next.source !== editor.value)
      editor.value = next.source;
    if (next.vncPort && !desktopConnected) {
      const url = new URL('/vnc.html?autoconnect=true&resize=scale', location.href);
      url.port = next.vncPort;
      desktop.src = url;
      desktopConnected = true;
    }
  }
  const phase = view?.phase;
  const paused = phase === 'paused';
  const ready = paused || phase === 'recording';
  statusLabel.dataset.phase = phase || 'starting';
  statusLabel.textContent = busy ? 'Đang xử lý…' : paused ? 'Đã tạm dừng' : ready ? 'Đang ghi' : 'Đang khởi động…';
  byId('recording-filename').textContent = view?.filename || 'Bản nháp TypeScript';
  byId('recording-help').textContent = paused
    ? 'Các thao tác ghi tiếp sẽ được nối sau phần đã sửa.'
    : 'Tạm dừng để sửa bản nháp.';
  byId('recording-editor').hidden = !paused;
  byId('recording-workspace').classList.toggle('editing', paused);
  editor.readOnly = busy || !paused;
  pauseButton.hidden = paused;
  resumeButton.hidden = !paused;
  pauseButton.disabled = resumeButton.disabled = saveButton.disabled = busy || !ready;
  cancelButton.disabled = busy || !view;
}

function end(message, closeTab) {
  finished = true;
  statusLabel.textContent = message;
  statusLabel.dataset.phase = '';
  errorLabel.textContent = '';
  desktop.remove();
  byId('recording-workspace').hidden = true;
  byId('back-to-manager').hidden = false;
  for (const button of [pauseButton, resumeButton, saveButton, cancelButton]) button.hidden = true;
  if (closeTab) window.close();
}

async function poll() {
  if (finished) return;
  const started = version;
  if (!busy) {
    try {
      const next = await request('');
      if (started === version && !finished) {
        if (view?.phase === 'paused' && view.revision !== next.revision && editor.value !== view.source)
          errorLabel.textContent = 'Phiên ghi đã đổi ở tab khác. Sao chép phần đang sửa trước khi tải lại.';
        else render(next);
      }
    } catch (error) {
      if (started === version && !finished) {
        if (error.status === 404) { end(error.message, false); return; }
        errorLabel.textContent = error.message;
      }
    }
  }
  if (!finished) setTimeout(poll, 1200);
}

async function act(action) {
  if (busy || finished) return;
  if (action === 'cancel' && !window.confirm('Hủy phiên ghi và bỏ bản nháp hiện tại?')) return;
  const payload = { revision: view.revision };
  if (view.phase === 'paused' && (action === 'resume' || action === 'save')) payload.source = editor.value;
  busy = true;
  version++;
  errorLabel.textContent = '';
  render();
  try {
    const result = await request('/' + action, payload);
    if (action === 'save' || action === 'cancel') end(result.message, true);
    else {
      render(result, true);
      if (action === 'pause') requestAnimationFrame(() => editor.focus());
    }
  } catch (error) {
    errorLabel.textContent = error.message;
  } finally {
    busy = false;
    if (!finished) render();
  }
}

pauseButton.onclick = () => act('pause');
resumeButton.onclick = () => act('resume');
saveButton.onclick = () => act('save');
cancelButton.onclick = () => act('cancel');
if (sessionId) poll();
else end('Hãy mở Browser Desktop từ một phiên ghi trong Studio.', false);
