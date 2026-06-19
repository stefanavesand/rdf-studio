const assert = require('assert');
const ox = require('oxigraph');

// ---- safeIri ----
function safeIri(iri) {
  return iri.replace(/[<>"{}|\\^`\n\r]/g, '');
}

// ---- findBlockEnd (from TurtleEditor) ----
function findBlockEnd(lines, startLine) {
  let inTripleQuote = false;
  for (let i = startLine; i < lines.length; i++) {
    const tqCount = (lines[i].match(/"""/g) || []).length;
    if (tqCount % 2 !== 0) { inTripleQuote = !inTripleQuote; }
    if (!inTripleQuote && lines[i].trimEnd().endsWith('.')) {
      return i;
    }
  }
  return startLine;
}

// ---- compact (from RdfStore) ----
function compact(iri, prefixes) {
  for (const [prefix, ns] of prefixes) {
    if (iri.startsWith(ns)) {
      const local = iri.slice(ns.length);
      return prefix ? `${prefix}:${local}` : `:${local}`;
    }
  }
  return `<${iri}>`;
}

// ---- compactForFile (from TurtleEditor) ----
function compactForFile(iri, fileText, prefixes) {
  const filePrefixes = new Map();
  const regex = /@prefix\s+(\w*)\s*:\s*<([^>]+)>\s*\./g;
  let m;
  while ((m = regex.exec(fileText)) !== null) {
    filePrefixes.set(m[1], m[2]);
  }
  for (const [prefix, ns] of filePrefixes) {
    if (iri.startsWith(ns)) {
      const local = iri.slice(ns.length);
      return prefix ? `${prefix}:${local}` : `:${local}`;
    }
  }
  return `<${iri}>`;
}

// ---- Minimal store for superclass tests ----
class TestStore {
  constructor() { this.store = new ox.Store(); }
  load(ttl) { this.store.load(ttl, { format: 'text/turtle' }, undefined, undefined); }
  query(sparql) {
    const prefix = 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\nPREFIX owl: <http://www.w3.org/2002/07/owl#>\nPREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n';
    const result = this.store.query(prefix + sparql, undefined);
    return Array.isArray(result) ? result : [];
  }
  localName(iri) { const parts = iri.split(/[#/]/); return parts[parts.length - 1] || iri; }
}

const GENERIC_IRIS = new Set([
  'http://www.w3.org/2000/01/rdf-schema#Resource', 'http://www.w3.org/2000/01/rdf-schema#Class',
  'http://www.w3.org/2002/07/owl#Thing', 'http://www.w3.org/2002/07/owl#Class',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property',
]);

function getSuperclassChain(store, classIri) {
  const chain = [];
  let current = classIri;
  const visited = new Set([current]);
  while (true) {
    const parents = store.query(`SELECT ?parent ?parentLabel WHERE { <${current}> rdfs:subClassOf ?parent . ?parent a owl:Class . FILTER(?parent != <${current}>) OPTIONAL { ?parent rdfs:label ?parentLabel } }`);
    const candidates = parents
      .filter(r => !GENERIC_IRIS.has(r.get('parent').value) && !visited.has(r.get('parent').value))
      .map(r => ({ iri: r.get('parent').value, label: r.get('parentLabel')?.value ?? store.localName(r.get('parent').value) }));
    if (candidates.length === 0) break;
    const candidateIris = new Set(candidates.map(c => c.iri));
    const mostSpecific = candidates.find(c => {
      const sups = store.query(`SELECT ?sup WHERE { <${c.iri}> rdfs:subClassOf ?sup . FILTER(?sup != <${c.iri}>) }`);
      return sups.some(r => candidateIris.has(r.get('sup').value));
    }) || candidates[0];
    chain.push(mostSpecific);
    visited.add(mostSpecific.iri);
    current = mostSpecific.iri;
  }
  return chain;
}

// ==== TESTS ====

describe('safeIri', function () {
  it('strips angle brackets', function () {
    assert.strictEqual(safeIri('http://x.org/a> . DROP ALL ; <http://x.org/b'), 'http://x.org/a . DROP ALL ; http://x.org/b');
  });
  it('strips newlines', function () {
    assert.strictEqual(safeIri('http://x.org/a\nDROP ALL'), 'http://x.org/aDROP ALL');
  });
  it('passes clean IRIs through', function () {
    assert.strictEqual(safeIri('http://example.org/foo#bar'), 'http://example.org/foo#bar');
  });
});

describe('findBlockEnd with triple-quoted strings', function () {
  it('finds period on normal block', function () {
    const lines = [':e a :Cls ;', '    rdfs:label "Test" .'];
    assert.strictEqual(findBlockEnd(lines, 0), 1);
  });

  it('skips period inside triple-quoted string', function () {
    const lines = [
      ':e a :Cls ;',
      '    rdfs:comment """This has a period.',
      'And more text.""" ;',
      '    rdfs:label "Test" .',
    ];
    assert.strictEqual(findBlockEnd(lines, 0), 3);
  });

  it('handles triple-quoted string on single line', function () {
    const lines = [':e a :Cls ;', '    rdfs:comment """A. B. C.""" .'];
    assert.strictEqual(findBlockEnd(lines, 0), 1);
  });
});

describe('compact returns full IRI for unknown prefixes', function () {
  it('returns <full-iri> when no prefix matches', function () {
    const prefixes = new Map([['ex', 'http://example.org/']]);
    assert.strictEqual(compact('http://unknown.org/foo', prefixes), '<http://unknown.org/foo>');
  });

  it('returns prefixed name when prefix matches', function () {
    const prefixes = new Map([['ex', 'http://example.org/']]);
    assert.strictEqual(compact('http://example.org/foo', prefixes), 'ex:foo');
  });
});

describe('compactForFile prefix isolation', function () {
  it('only uses prefixes declared in the target file', function () {
    const fileA = '@prefix fine: <http://example.org/fine#> .\n';
    const fileB = '@prefix ar: <http://example.org/ar#> .\n';
    const allPrefixes = new Map([['fine', 'http://example.org/fine#'], ['ar', 'http://example.org/ar#']]);

    assert.strictEqual(compactForFile('http://example.org/fine#Squad', fileA, allPrefixes), 'fine:Squad');
    assert.strictEqual(compactForFile('http://example.org/ar#System', fileA, allPrefixes), '<http://example.org/ar#System>');
    assert.strictEqual(compactForFile('http://example.org/ar#System', fileB, allPrefixes), 'ar:System');
  });
});

describe('getSuperclassChain', function () {
  it('returns correct chain A → B → C', function () {
    const store = new TestStore();
    store.load(`
      @prefix : <http://ex.org/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      :A a owl:Class ; rdfs:subClassOf :B ; rdfs:label "A" .
      :B a owl:Class ; rdfs:subClassOf :C ; rdfs:label "B" .
      :C a owl:Class ; rdfs:label "C" .
    `);
    const chain = getSuperclassChain(store, 'http://ex.org/A');
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].label, 'B');
    assert.strictEqual(chain[1].label, 'C');
  });

  it('handles RDFS transitive inference (picks most specific)', function () {
    const store = new TestStore();
    store.load(`
      @prefix : <http://ex.org/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      :FineSquad a owl:Class ; rdfs:subClassOf :Squad ; rdfs:label "Fine Squad" .
      :Squad a owl:Class ; rdfs:subClassOf :Organization ; rdfs:label "Squad" .
      :Organization a owl:Class ; rdfs:label "Organization" .
    `);
    const chain = getSuperclassChain(store, 'http://ex.org/FineSquad');
    assert.strictEqual(chain.length, 2);
    assert.strictEqual(chain[0].label, 'Squad');
    assert.strictEqual(chain[1].label, 'Organization');
  });

  it('terminates on cycles', function () {
    const store = new TestStore();
    store.load(`
      @prefix : <http://ex.org/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      :A a owl:Class ; rdfs:subClassOf :B ; rdfs:label "A" .
      :B a owl:Class ; rdfs:subClassOf :A ; rdfs:label "B" .
    `);
    const chain = getSuperclassChain(store, 'http://ex.org/A');
    assert.strictEqual(chain.length, 1);
    assert.strictEqual(chain[0].label, 'B');
  });

  it('returns empty for root class', function () {
    const store = new TestStore();
    store.load(`
      @prefix : <http://ex.org/> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      :Root a owl:Class .
    `);
    const chain = getSuperclassChain(store, 'http://ex.org/Root');
    assert.strictEqual(chain.length, 0);
  });
});

describe('remote triple diffing', function () {
  it('only shows new triples as inherited', function () {
    const localFields = new Set(['http://ex.org/p1|value1']);
    const remoteTriples = [
      { predicate: 'http://ex.org/p1', value: 'value1', isIri: false },
      { predicate: 'http://ex.org/p2', value: 'value2', isIri: false },
      { predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', value: 'http://ex.org/Cls', isIri: true },
    ];
    const skipPredicates = new Set(['http://www.w3.org/1999/02/22-rdf-syntax-ns#type']);
    const filtered = remoteTriples.filter(t => !skipPredicates.has(t.predicate) && !localFields.has(`${t.predicate}|${t.value}`));
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0].predicate, 'http://ex.org/p2');
  });
});

describe('delete triple edge cases', function () {
  it('last triple — previous semicolon becomes period', function () {
    const lines = [
      ':e a :Cls ;',
      '    rdfs:label "Test" ;',
      '    :prop "value" .',
    ];
    const deleteLine = 2;
    lines.splice(deleteLine, 1);
    const prevLine = lines[deleteLine - 1];
    const fixed = prevLine.replace(/;\s*$/, ' .');
    lines[deleteLine - 1] = fixed;
    assert(lines[deleteLine - 1].trimEnd().endsWith('.'));
    assert.strictEqual(lines.length, 2);
  });

  it('only triple — entire subject removed', function () {
    const lines = [':e a :Cls .'];
    const blockStart = 0;
    const blockEnd = findBlockEnd(lines, 0);
    assert.strictEqual(blockStart, blockEnd);
  });
});

describe('add triple to single-line block', function () {
  it('splits single-line block into multi-line', function () {
    const line = ':e a :Cls .';
    const match = line.match(/^(.+)\s+\.$/);
    assert(match, 'should match single-line block pattern');
    const base = match[1];
    const newLines = [base + ' ;', '    :newProp "value" .'];
    assert.strictEqual(newLines[0], ':e a :Cls ;');
    assert(newLines[1].trimEnd().endsWith('.'));
  });
});
