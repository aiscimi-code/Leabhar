// Records every file under docs/ that a process reads (issue #291).
//   rm -f docs-reads.log
//   NODE_OPTIONS="--require ./scripts/docs-inventory/trace-reads.cjs" npm test
// then run inventory.py, which reads docs-reads.log from the repository root.
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const docs = path.join(root, 'docs') + path.sep;
const log = path.join(root, 'docs-reads.log');
const append = fs.appendFileSync;

const record = (p) => {
  try {
    const abs = path.resolve(p instanceof URL ? p.pathname : String(p));
    if (abs.startsWith(docs)) append(log, path.relative(root, abs) + '\n');
  } catch { /* a descriptor or a buffer: not a path */ }
};

for (const fn of ['readFileSync', 'existsSync', 'readdirSync', 'statSync', 'openSync', 'readFile', 'readdir', 'stat', 'createReadStream']) {
  const original = fs[fn];
  fs[fn] = function (p, ...rest) { record(p); return original.call(this, p, ...rest); };
}
for (const fn of ['readFile', 'readdir', 'stat', 'open']) {
  const original = fs.promises[fn];
  fs.promises[fn] = function (p, ...rest) { record(p); return original.call(this, p, ...rest); };
}
