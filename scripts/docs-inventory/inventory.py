"""Classify every tracked file under docs/ (issue #291).

Run trace-reads.cjs under the test suite first (see its header); the suite
calls loadStatutoryKnowledgeBase, so what it reads is also what the app reads
at run time. Writes docs/docs-inventory.csv and prints a per-folder summary.

Classes, first match wins:
  runtime      read by the test suite / knowledge base load
  cited-code   named by its path in src/ or scripts/ (a string or a comment)
  duplicate    in _inbox, byte-identical to a file outside _inbox
  original     a PDF/HTML whose SHA-256 a converted .md records
  cited-docs   named by another doc, README.md or AGENTS.md
  unreferenced none of the above
"""
import collections, csv, hashlib, os, re, subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
os.chdir(ROOT)

def git_files(*paths):
    return [f for f in subprocess.check_output(['git', 'ls-files', *paths]).decode().split('\n') if f]

def text(f):
    with open(f, encoding='utf8', errors='ignore') as h:
        return h.read()

def sha(f):
    with open(f, 'rb') as h:
        return hashlib.sha256(h.read()).hexdigest()

files = git_files('docs')
reads = set(l.strip() for l in open('docs-reads.log')) if os.path.exists('docs-reads.log') else set()
if not reads:
    raise SystemExit('docs-reads.log is missing or empty: run the traced test suite first.')

code = {f: text(f) for f in git_files('src', 'scripts') if f.endswith(('.ts', '.tsx', '.mjs', '.cjs', '.js', '.py'))
        and not f.startswith('scripts/docs-inventory/')}
docs_text = {f: text(f) for f in files if f.endswith(('.md', '.txt', '.json', '.csv'))}
docs_text.update({f: text(f) for f in ['README.md', 'AGENTS.md']})

hashes = {f: sha(f) for f in files}
recorded = collections.defaultdict(list)
for f, t in docs_text.items():
    for m in re.finditer(r'source_(?:pdf|html)_sha256:\s*"?([0-9a-f]{64})', t):
        recorded[m.group(1)].append(f)
outside_inbox = collections.defaultdict(list)
for f, h in hashes.items():
    if '/_inbox/' not in f:
        outside_inbox[h].append(f)

def mentions(f):
    base, folder = os.path.basename(f), os.path.dirname(f)
    forms = {f, f[len('docs/'):], f[len('docs/statutes/'):] if f.startswith('docs/statutes/') else f}
    return [d for d, t in docs_text.items() if d != f and (
        any(x in t for x in forms) or (os.path.dirname(d) == folder and base in t))]

rows = []
for f in files:
    by_code = [c for c, t in code.items() if f in t]
    twin = outside_inbox.get(hashes[f], []) if '/_inbox/' in f else []
    backs = recorded.get(hashes[f], [])
    by_docs = mentions(f)
    if f in reads: cls, why = 'runtime', 'read by the test suite'
    elif by_code: cls, why = 'cited-code', ' '.join(by_code)
    elif twin: cls, why = 'duplicate', ' '.join(twin)
    elif backs and f.endswith(('.pdf', '.html')): cls, why = 'original', ' '.join(backs)
    elif by_docs: cls, why = 'cited-docs', ' '.join(by_docs[:3]) + (' …' if len(by_docs) > 3 else '')
    else: cls, why = 'unreferenced', ''
    rows.append((f, os.path.getsize(f), cls, why))

with open('docs/docs-inventory.csv', 'w', newline='') as h:
    w = csv.writer(h)
    w.writerow(['path', 'bytes', 'class', 'why'])
    w.writerows(rows)

def group(f):
    p = f.split('/')
    if len(p) <= 2: return f
    if p[1] != 'statutes': return '/'.join(p[:2])
    if len(p) == 3: return f
    if p[2] == '_inbox' and len(p) > 4: return '/'.join(p[:4])
    return '/'.join(p[:3])

summary = collections.defaultdict(collections.Counter)
for f, size, cls, _ in rows:
    summary[group(f)][cls] += size
    summary['TOTAL'][cls] += size
classes = ['runtime', 'cited-code', 'duplicate', 'original', 'cited-docs', 'unreferenced']
print('| Folder | ' + ' | '.join(classes) + ' |')
print('|---|' + '---:|' * len(classes))
for g in sorted(summary, key=lambda g: (g == 'TOTAL', g)):
    print(f'| {g} | ' + ' | '.join(f'{summary[g][c] / 1e6:.2f}' if summary[g][c] else '' for c in classes) + ' |')
