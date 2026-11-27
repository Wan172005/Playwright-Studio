'use strict';
const path = require('node:path');

function prepareSource(source, { filename, runtimeFile, baseUrl, convertUrls = false, rebaseOnly = false }) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 512 * 1024) {
    throw Object.assign(new Error('Nội dung script cần từ 1 đến 512 KiB.'), { status: 400 });
  }
  const { babelParse, traverse } = require('playwright/lib/transform/babelBundle');
  let ast;
  try { ast = babelParse(source, filename, true); }
  catch (error) { throw Object.assign(new Error(`TypeScript không hợp lệ: ${error.message}`), { status: 400 }); }
  const replacements = [];
  const needed = new Set();
  const imported = new Set();
  const bindings = new Map(), identifiers = new Set(), runtimeLocals = new Map();
  traverse(ast, {
    Identifier(p) { identifiers.add(p.node.name); if (p.isBindingIdentifier()) bindings.set(p.node.name, (bindings.get(p.node.name) || 0) + 1); },
    ImportDeclaration(p) {
      if (/(?:^|\/)manager\/runtime\/dataset(?:\.ts)?$/.test(p.node.source.value)) {
        for (const spec of p.node.specifiers) if (spec.type === 'ImportSpecifier') runtimeLocals.set(spec.imported.name, spec.local.name);
      }
    },
  });
  const helperExports = new Map([['data', 'data'], ['webUrl', 'webUrl']]);
  function generatedHelper(exported) {
    const existing = runtimeLocals.get(exported);
    if (existing && bindings.get(existing) === 1) return existing;
    if (!bindings.has(exported)) return exported;
    let local = exported === 'data' ? 'studioData' : 'studioWebUrl';
    while (identifiers.has(local)) local += '_';
    helperExports.set(local, exported); return local;
  }
  const dataHelper = generatedHelper('data'), urlHelper = generatedHelper('webUrl');
  let origin;
  try { origin = new URL(baseUrl).origin; } catch { /* Optional project URL. */ }
  let modulePath = path.relative(path.dirname(filename), runtimeFile).split(path.sep).join('/').replace(/\.ts$/, '');
  if (!modulePath.startsWith('.')) modulePath = `./${modulePath}`;
  const templateExpression = value => {
    const parts = []; let last = 0;
    for (const match of value.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)) {
      if (match.index > last) parts.push(JSON.stringify(value.slice(last, match.index)));
      parts.push(`${dataHelper}(${JSON.stringify(match[1])})`); last = match.index + match[0].length;
    }
    if (!parts.length) return null;
    if (last < value.length) parts.push(JSON.stringify(value.slice(last)));
    needed.add(dataHelper);
    return parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`;
  };
  traverse(ast, {
    ImportDeclaration(p) {
      if (/(?:^|\/)manager\/runtime\/dataset(?:\.ts)?$/.test(p.node.source.value)) {
        for (const item of p.node.specifiers) if (item.type === 'ImportSpecifier') imported.add(item.local.name);
        replacements.push({ start: p.node.source.start, end: p.node.source.end, text: JSON.stringify(modulePath) });
      }
    },
    CallExpression(p) {
      if (rebaseOnly) return;
      if (p.node.callee.type === 'Identifier' && ['data', 'webUrl'].includes(p.node.callee.name) && !p.scope.hasBinding(p.node.callee.name)) needed.add(p.node.callee.name);
      if (!convertUrls || !origin || p.node.callee.type !== 'MemberExpression' || p.node.callee.property.name !== 'goto') return;
      const arg = p.node.arguments[0];
      if (arg?.type !== 'StringLiteral') return;
      try {
        const target = new URL(arg.value);
        if (target.origin === origin) {
          needed.add(urlHelper);
          const relative = (target.pathname + target.search + target.hash).replace(/%7B%7B([A-Za-z_][A-Za-z0-9_]*)%7D%7D/gi, '{{$1}}');
          replacements.push({ start: arg.start, end: arg.end, text: `${urlHelper}(${templateExpression(relative) || JSON.stringify(relative)})` });
        }
      } catch { /* Relative URLs already use Playwright's baseURL. */ }
    },
    StringLiteral(p) {
      if (rebaseOnly || p.parent.type === 'ImportDeclaration' || (p.parent.type === 'ObjectProperty' && p.parent.key === p.node && !p.parent.computed)) return;
      if (replacements.some(edit => edit.start === p.node.start && edit.end === p.node.end)) return;
      const expression = templateExpression(p.node.value);
      if (expression) replacements.push({ start: p.node.start, end: p.node.end, text: expression });
    },
  });
  const extra = [...needed].filter(name => !imported.has(name));
  if (extra.length) replacements.push({ start: 0, end: 0, text: `import { ${extra.map(local => helperExports.get(local) && helperExports.get(local) !== local ? `${helperExports.get(local)} as ${local}` : local).join(', ')} } from ${JSON.stringify(modulePath)};\n` });
  // A URL replacement owns its literal; avoid overlapping placeholder edits.
  const edits = replacements.filter(r => !replacements.some(other => other !== r && other.start <= r.start && other.end >= r.end && other.end - other.start > r.end - r.start));
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
module.exports = { prepareSource };
