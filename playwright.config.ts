import { defineConfig, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { runtimeProjectName } from './manager/project-runtime';

const dataDir = process.env.STUDIO_DATA_DIR || path.join(__dirname, '.studio');
const scriptsDir = process.env.SCRIPTS_DIR || path.join(dataDir, 'scripts');
const artifactsDir = process.env.STUDIO_ARTIFACTS_DIR || __dirname;
const manifest = path.join(dataDir, 'projects.json');
function loadProjects() {
  const projects: { id: string; name: string; url?: string; defaultEnvironmentId?: string; environments?: { id: string; name: string; baseURL?: string }[] }[] = fs.existsSync(manifest)
    ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : [];
  return projects.flatMap(project => [undefined, ...(project.environments || [])].map(environment => ({
    name: runtimeProjectName(project, environment),
    testDir: path.join(scriptsDir, project.id),
    use: { ...devices['Desktop Chrome'], baseURL: environment?.baseURL || (!environment && project.environments?.find(e => e.id === project.defaultEnvironmentId)?.baseURL) || project.url || undefined },
    metadata: { studioProjectId: project.id, studioEnvironmentId: environment?.id,
      studioDatasetFile: (environment?.id || project.defaultEnvironmentId) ? path.join(dataDir, 'datasets', `${environment?.id || project.defaultEnvironmentId}.json`) : undefined },
  })));
}

const config = defineConfig({
  testDir: scriptsDir,
  testMatch: '**/*.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  reporter: [['list'], ['html', { outputFolder: path.join(artifactsDir, 'playwright-report'), open: 'never' }]],
  outputDir: path.join(artifactsDir, 'test-results'),
  timeout: 60_000,
  expect: { timeout: 8_000 },
  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    headless: false,
    launchOptions: { slowMo: 300 },
  },
});

// UI Mode caches the config module, including after an empty first startup.
// Attach the getter AFTER defineConfig (which spreads/evaluates properties) so every
// config load reads the current registry without restarting UI or interrupting tests.
Object.defineProperty(config, 'projects', { enumerable: true, get: loadProjects });

export default config;
