import fs from 'node:fs';
import { test, type TestInfo } from '@playwright/test';

const valuesByTest = new WeakMap<TestInfo, Record<string, string>>();

// Values belong to the current Playwright project/environment, never to global process.env.
export function data(key: string): string {
  const info = test.info();
  let values = valuesByTest.get(info);
  if (!values) {
    const file = info.project.metadata.studioDatasetFile;
    values = file ? JSON.parse(fs.readFileSync(String(file), 'utf8')) : {};
    valuesByTest.set(info, values!);
  }
  if (Object.prototype.hasOwnProperty.call(values, key)) return values![key];
  if (key === 'BASE_URL' && info.project.use.baseURL) return String(info.project.use.baseURL);
  throw new Error(`Dataset thiếu biến ${key}. Chọn môi trường và thêm biến trong Manager.`);
}

export function webUrl(value: string): string {
  const base = data('BASE_URL');
  return new URL(value, base).toString();
}
