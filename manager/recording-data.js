'use strict';
const { prepareSource } = require('./script-source');

// Codegen output only. Hand-edited source never goes through this conversion.
function parameterizeRecording(source, options, existing = {}) {
  const { babelParse, traverse } = require('playwright/lib/transform/babelBundle');
  const ast = babelParse(source, options.filename, true);
  const variables = Object.assign(Object.create(null), existing), edits = [], assigned = new Map();
  if (!variables.BASE_URL) variables.BASE_URL = new URL(options.baseUrl).origin;
  const literal = node => node?.type === 'StringLiteral' ? node.value : null;
  function keyFor(label, value) {
    let base = String(label).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'InputValue';
    if (/^\d/.test(base)) base = `Value_${base}`;
    if (['BASE_URL', '__proto__', 'prototype', 'constructor'].includes(base)) base = `Input_${base}`;
    const known = Object.keys(variables).find(key => key.toLowerCase() === base.toLowerCase());
    base = known || base;
    let key = base, index = 2;
    while ((Object.hasOwn(variables, key) && variables[key] !== value) || (assigned.has(key) && assigned.get(key) !== value)) key = `${base}_${index++}`;
    // Existing dataset values are authoritative. A new key receives the recorded value.
    if (!Object.hasOwn(variables, key)) variables[key] = value;
    assigned.set(key, value); return key;
  }
  function fieldName(node) {
    if (!node || node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return '';
    const method = node.callee.property.name;
    if (method === 'getByRole') {
      const option = node.arguments[1]?.properties?.find(p => p.key?.name === 'name' || p.key?.value === 'name');
      if (literal(option?.value)) return literal(option.value);
    }
    if (['getByLabel', 'getByPlaceholder', 'getByTestId'].includes(method) && literal(node.arguments[0])) return literal(node.arguments[0]);
    if (method === 'locator' && literal(node.arguments[0])) return selectorName(literal(node.arguments[0]));
    return fieldName(node.callee.object);
  }
  function selectorName(selector) { return selector.match(/#([\w-]+)/)?.[1] || selector.match(/\[(?:name|placeholder)=["']?([^\]"']+)/)?.[1] || 'InputValue'; }
  function replace(node, label, value = literal(node)) {
    if (value === null || !node) return;
    edits.push({ start: node.start, end: node.end, text: JSON.stringify(`{{${keyFor(label, value)}}}`) });
  }
  let urlIndex = 0;
  traverse(ast, {
    CallExpression(p) {
      const call = p.node;
      if (options.generatedCalls && !options.generatedCalls.has(source.slice(call.start, call.end))) return;
      if (call.callee.type !== 'MemberExpression' || call.callee.computed) return;
      const method = call.callee.property.name, args = call.arguments;
      const field = fieldName(call.callee.object);
      if (['fill', 'type', 'pressSequentially', 'insertText'].includes(method)) {
        const pageStyle = call.callee.object.type === 'Identifier' && call.callee.object.name === 'page';
        replace(args[pageStyle ? 1 : 0], field || (pageStyle ? selectorName(literal(args[0]) || '') : 'InputValue'));
      }
      if (method === 'selectOption') {
        const pageStyle = call.callee.object.type === 'Identifier' && call.callee.object.name === 'page';
        const arg = args[pageStyle ? 1 : 0], label = field || 'SelectedValue';
        if (arg?.type === 'ArrayExpression') arg.elements.forEach((node, i) => replace(node, `${label}_${i + 1}`));
        else if (arg?.type === 'ObjectExpression') arg.properties.forEach(prop => { if (['value','label'].includes(prop.key?.name || prop.key?.value)) replace(prop.value, label); });
        else replace(arg, label);
      }
      if (['toHaveValue', 'toHaveText', 'toContainText', 'toHaveURL', 'toHaveTitle'].includes(method)) {
        const subject = call.callee.object;
        const name = subject.type === 'CallExpression' && subject.callee.name === 'expect' ? fieldName(subject.arguments[0]) : '';
        if (args[0]?.type === 'ArrayExpression') args[0].elements.forEach((node, i) => replace(node, `${name || 'Expected'}_${i + 1}`));
        else replace(args[0], `${name || 'Expected'}_Expected`);
      }
      if (method === 'goto' && literal(args[0]) !== null) {
        const raw = literal(args[0]); let relative = raw, sameOrigin = false;
        try {
          const target = new URL(raw, options.baseUrl), base = new URL(options.baseUrl);
          sameOrigin = target.origin === base.origin;
          if (sameOrigin) relative = target.pathname + target.search + target.hash;
        } catch { /* Non-web navigation remains a dataset value. */ }
        const placeholder = JSON.stringify(`{{${keyFor(`URL_${++urlIndex}`, relative)}}}`);
        edits.push({ start: args[0].start, end: args[0].end, text: sameOrigin ? `webUrl(${placeholder})` : placeholder });
      }
    },
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return { source: prepareSource(source, options), variables };
}
function generatedCallTexts(source, filename) {
  const { babelParse, traverse } = require('playwright/lib/transform/babelBundle');
  const calls = new Set();
  traverse(babelParse(source, filename, true), {
    CallExpression({ node }) { calls.add(source.slice(node.start, node.end)); },
  });
  return calls;
}

module.exports = { parameterizeRecording, generatedCallTexts };
