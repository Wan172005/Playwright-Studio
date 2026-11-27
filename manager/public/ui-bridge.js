'use strict';
// Playwright accepts project/arg filters. The bridge adds file selection and one-shot sequential execution.
(async () => {
  const params = new URLSearchParams(location.search);
  if (!params.has('studioFile') && !params.has('studioSelection')) return;
  const notice = document.createElement('div');
  Object.assign(notice.style, { position: 'fixed', bottom: '16px', right: '18px', zIndex: '9999', maxWidth: '480px',
    padding: '12px 16px', background: '#292a2f', color: '#f0f0f1', border: '1px solid #55565d', font: '14px/1.5 system-ui' });
  const back = document.createElement('a'); back.href = '/'; back.textContent = 'Về Manager'; back.style.color = '#ff8c79';
  const status = document.createElement('div'); status.textContent = `Đang mở ${params.get('studioProject')}…`;
  notice.append(status, back); document.body.append(notice);
  let files = params.getAll('studioFile');
  if (params.has('studioSelection')) {
    try {
      const response = await fetch(`./studio-selection.json?id=${encodeURIComponent(params.get('studioSelection'))}`);
      const selection = await response.json();
      if (!response.ok) throw new Error(selection.error || 'Không tải được lựa chọn.');
      files = selection.files;
    } catch (error) { status.textContent = error.message; return; }
  }
  let done = false;
  let observer;
  let timeout;
  function selectAndRun() {
    if (done) return;
    const labels = [...document.querySelectorAll('[data-testid="test-tree"] .ui-mode-tree-item-title > span')];
    const matches = files.map(file => labels.find(element => element.textContent === file));
    if (!matches.length || matches.some(label => !label)) return;
    const row = matches[0].closest('.ui-mode-tree-item');
    const run = files.length === 1 ? row?.querySelector('[title="Run"]') : document.querySelector('[title^="Run all"]');
    if (!run || run.disabled || run.getAttribute('aria-disabled') === 'true') return;
    done = true; observer.disconnect(); clearTimeout(timeout);
    row.click();
    const description = files.length === 1 ? files[0] : `${files.length} script (chạy lần lượt)`;
    if (params.get('studioRun') === '1') {
      params.set('studioRun', '0'); history.replaceState(null, '', `${location.pathname}?${params}`);
      run.click(); status.textContent = `Đã chọn và chạy: ${description}`;
    } else status.textContent = `Đã chọn: ${description}`;
    setTimeout(() => notice.remove(), 7000);
  }
  observer = new MutationObserver(selectAndRun);
  observer.observe(document.getElementById('root') || document.body, { childList: true, subtree: true, attributes: true });
  timeout = setTimeout(() => {
    if (done) return;
    observer.disconnect(); status.textContent = 'Chưa tải được đủ script. Kiểm tra lỗi test trong Playwright UI hoặc quay về Manager để thử lại.';
  }, 25000);
  selectAndRun();
})();
