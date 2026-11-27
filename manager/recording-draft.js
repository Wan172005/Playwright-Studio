'use strict';

function testBody(source, filename) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 512 * 1024)
    throw Object.assign(new Error('Bản nháp cần có tối đa 512 KiB.'), { status: 400 });
  const { babelParse } = require('playwright/lib/transform/babelBundle');
  let ast;
  try { ast = babelParse(source, filename, true); }
  catch (error) { throw Object.assign(new Error(`TypeScript không hợp lệ: ${error.message}`), { status: 400 }); }
  const tests = ast.program.body.filter(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression' && node.expression.callee.name === 'test');
  const body = tests[0]?.expression.arguments.at(-1)?.body;
  if (tests.length !== 1 || body?.type !== 'BlockStatement')
    throw Object.assign(new Error('Bản nháp cần giữ một khối test(...) để nối các bước ghi tiếp.'), { status: 400 });
  return body;
}

function appendSteps(source, steps, filename) {
  if (!steps) return source;
  const end = testBody(source, filename).end - 1;
  const lineStart = source.lastIndexOf('\n', end - 1) + 1;
  const insertion = /^\s*$/.test(source.slice(lineStart, end)) ? lineStart : end;
  const prefix = source.slice(0, insertion);
  return `${prefix}${prefix.endsWith('\n') ? '' : '\n'}${steps}\n${source.slice(insertion)}`;
}

module.exports = { testBody, appendSteps };
