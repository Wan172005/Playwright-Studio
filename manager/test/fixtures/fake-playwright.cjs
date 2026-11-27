'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const target = args[args.indexOf('--output') + 1];
fs.writeFileSync(target, "import { test, expect } from '@playwright/test';\ntest('test', async () => { expect(1).toBe(1); });\n");
process.on('SIGINT', () => process.exit(130));
setInterval(() => {}, 1000);
