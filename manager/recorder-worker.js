'use strict';

const { chromium } = require('playwright');
const { appendSteps } = require('./recording-draft');
const [outputFile, url, name] = process.argv.slice(2);
const language = 'playwright-test';

async function run() {
  let browser, stopping = false;
  const stop = () => {
    stopping = true;
    return browser?.close().catch(() => process.exit(1));
  };
  for (const event of ['SIGINT', 'SIGTERM', 'disconnect']) process.once(event, stop);
  const headless = Boolean(process.env.PWTEST_CLI_HEADLESS);
  browser = await chromium.launch({ headless, handleSIGINT: false, handleSIGTERM: false,
    executablePath: process.env.PWTEST_CLI_EXECUTABLE_PATH });
  browser.on('disconnected', () => process.exit(0));
  if (stopping) return stop();
  const contextOptions = headless ? {} : { deviceScaleFactor: process.platform === 'darwin' ? 2 : 1 };
  const context = await browser.newContext(contextOptions);
  context.on('page', page => {
    page.on('dialog', () => {});
    page.once('close', () => {
      if (!context.pages().length) browser.close().catch(() => {});
    });
  });
  await context._showRecorder({ language, mode: 'recording', outputFile, handleSIGINT: false, contextOptions });

  // The pinned Playwright version exposes Inspector control through its in-process implementation.
  const app = context._connection.toImpl(context).recorderAppForTest;
  if (!app?._recorder || !Array.isArray(app._actions)) throw new Error('Không truy cập được Playwright Recorder.');
  const recorder = app._recorder;
  const setMode = recorder.setMode.bind(recorder);
  const generated = () => app._recorderSources.find(source => source.id === language);
  let paused = false, checkpoint = null;
  recorder.setMode = mode => paused ? Promise.resolve() : setMode(mode);

  function draft() {
    const source = generated();
    if (!checkpoint) {
      const namedSource = source.text.replace(/\btest\(\s*(['"])test\1\s*,/, () => `test(${JSON.stringify(name)},`);
      return { source: namedSource };
    }
    const firstNew = app._actions[checkpoint.rawCount];
    const previous = checkpoint.last?.action;
    const next = firstNew?.action;
    // Codegen coalesces consecutive fills, even across a pause. Include the newer fill
    // as a fresh step while keeping the previously edited step in Studio's draft.
    const mergedFill = previous?.name === 'fill' && next?.name === 'fill'
      && previous.selector === next.selector && checkpoint.last.pageGuid === firstNew.pageGuid;
    const steps = source.actions.slice(checkpoint.generatedCount - Number(mergedFill)).join('\n');
    return { source: appendSteps(checkpoint.source, steps, outputFile), steps };
  }

  // Keep the Inspector's TypeScript view on the same draft as the Studio editor.
  app._pushAllSources = () => {
    const { source: text } = draft();
    const sources = app._recorderSources.map(source => source.id === language
      ? { ...source, text, revealLine: text.split('\n').length - 1 }
      : source);
    app._frontend.sourcesUpdated({ sources: [...app._userSources, ...sources] });
  };

  const page = await context.newPage();
  page.goto(url).catch(error => console.error(error.message));
  process.on('message', async ({ id, command, source }) => {
    try {
      if (command === 'pause') {
        paused = true;
        recorder.flushPendingActions();
        await setMode('standby');
      } else if (command === 'resume') {
        checkpoint = { source, rawCount: app._actions.length, generatedCount: generated().actions.length,
          last: app._actions.at(-1) };
        app._pushAllSources();
        await setMode('recording');
        paused = false;
      }
      process.send?.({ id, result: command === 'resume' ? {} : draft() });
    } catch (error) {
      process.send?.({ id, error: error.message });
    }
  });
  process.send?.({ ready: true });
}
run().catch(error => { console.error(error.message); process.exit(1); });
