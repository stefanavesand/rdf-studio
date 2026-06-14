const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ox = require('oxigraph');

const modelDir = path.join(__dirname, '../../../domains/revenue-platform/knowledge/ar-subledger-kg/model');
const platformDir = path.join(__dirname, '../../../domains/fine-platform/knowledge/platform-kg/model');
const platformFile = path.join(platformDir, 'fp-enterprise.ttl');

// ---- Minimal RdfStore-like wrapper for testing ----
class TestStore {
  constructor() {
    this.store = new ox.Store();
    this.prefixes = new Map();
    this.sourceMap = new Map();
  }

  load(filePath) {
    const text = fs.readFileSync(filePath, 'utf-8');
    const regex = /@prefix\s+(\w*)\s*:\s*<([^>]+)>\s*\./g;
    let m;
    while ((m = regex.exec(text)) !== null) {
      this.prefixes.set(m[1], m[2]);
    }
    // build source map
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prefixed = line.match(/^(\w*):(\S+)/);
      if (prefixed && !line.startsWith('@') && !line.startsWith('#')) {
        const ns = this.prefixes.get(prefixed[1]);
        if (ns) {
          const local = prefixed[2].replace(/\s.*$/, '');
          this.sourceMap.set(ns + local, { file: filePath, line: i });
        }
      }
    }
    this.store.load(text, { format: 'text/turtle' }, undefined, undefined);
  }

  query(sparql) {
    const header = [
      'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
      'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
      'PREFIX owl: <http://www.w3.org/2002/07/owl#>',
      'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
    ];
    for (const [prefix, ns] of this.prefixes) {
      header.push(`PREFIX ${prefix}: <${ns}>`);
    }
    const result = this.store.query(header.join('\n') + '\n' + sparql, undefined);
    return Array.isArray(result) ? result : [];
  }

  compact(iri) {
    for (const [prefix, ns] of this.prefixes) {
      if (iri.startsWith(ns)) {
        const local = iri.slice(ns.length);
        return prefix ? `${prefix}:${local}` : `:${local}`;
      }
    }
    return this.localName(iri);
  }

  localName(iri) {
    const parts = iri.split(/[#/]/);
    return parts[parts.length - 1] || iri;
  }

  getLabel(iri) {
    const rows = this.query(`SELECT ?label WHERE { <${iri}> rdfs:label ?label } LIMIT 1`);
    return rows[0]?.get('label')?.value;
  }

  getDefinitionLocation(iri) {
    return this.sourceMap.get(iri);
  }
}

// ---- Core functions extracted from TurtleEditor ----

function buildObjectMatchers(store, subjectIri, predicateIri, objectValue, label) {
  const matchers = [];

  // if a display label was provided, use it first
  if (label) { matchers.push(label); }

  const isBlankNode = !objectValue.includes(':') && !objectValue.includes('/');

  if (!isBlankNode) {
    matchers.push(store.compact(objectValue));
    matchers.push(store.localName(objectValue));
    matchers.push(objectValue);
    try {
      const storeLabel = store.getLabel(objectValue);
      if (storeLabel) { matchers.push(storeLabel); }
    } catch { /* */ }
  }

  if (isBlankNode || matchers.length <= 1) {
    try {
      const rows = store.query(`
        SELECT ?label WHERE {
          <${subjectIri}> <${predicateIri}> ?o .
          ?o rdfs:label ?label .
        }
      `);
      for (const r of rows) {
        const l = r.get('label')?.value;
        if (l) { matchers.push(l); }
      }
    } catch { /* */ }
  }

  return matchers.filter(m => m && m.length > 1);
}

function findBlockEnd(lines, startLine) {
  for (let i = startLine; i < lines.length; i++) {
    if (lines[i].trimEnd().endsWith('.')) {
      return i;
    }
  }
  return startLine;
}

function findDeleteTarget(lines, subjectLine, blockEnd, predCompact, predLocal, matchers) {
  // pass 1: predicate + object on the same line
  for (let i = subjectLine; i <= blockEnd; i++) {
    const line = lines[i];
    const hasPred = line.includes(predCompact) || line.includes(predLocal);
    if (!hasPred) { continue; }
    if (matchers.some(c => line.includes(c))) {
      return { line: i, type: 'same-line' };
    }
  }

  // pass 2: object on any line, predicate earlier in block
  for (let i = subjectLine; i <= blockEnd; i++) {
    const line = lines[i];
    if (matchers.some(c => line.includes(c))) {
      const blockText = lines.slice(subjectLine, i + 1).join('\n');
      if (blockText.includes(predCompact) || blockText.includes(predLocal)) {
        return { line: i, type: 'blank-node' };
      }
    }
  }

  return null;
}

// ---- TESTS ----

describe('TestStore basics', function () {
  let store;

  before(function () {
    if (!fs.existsSync(modelDir)) { this.skip(); }
    store = new TestStore();
    const ttlFiles = fs.readdirSync(modelDir).filter(f => f.endsWith('.ttl'));
    for (const f of ttlFiles) {
      store.load(path.join(modelDir, f));
    }
  });

  it('can query classes', function () {
    const rows = store.query('SELECT ?cls WHERE { ?cls a owl:Class } LIMIT 5');
    assert(rows.length > 0);
  });

  it('compact produces prefixed names', function () {
    assert.strictEqual(store.compact('https://spotify.net/ns/fin/ar#System'), 'ar:System');
  });
});

describe('findBlockEnd', function () {
  it('finds the line ending with a period', function () {
    const lines = [':e a ar:System ;', '    rdfs:label "Test" ;', '    ar:produces :d .', ''];
    assert.strictEqual(findBlockEnd(lines, 0), 2);
  });
});

describe('Delete: real file - Billing capability hasFeature', function () {
  let store;
  let lines;
  let subjectLine;
  let blockEnd;

  before(function () {
    if (!fs.existsSync(platformFile)) { this.skip(); }
    store = new TestStore();
    const ttlFiles = fs.readdirSync(platformDir).filter(f => f.endsWith('.ttl'));
    for (const f of ttlFiles) {
      store.load(path.join(platformDir, f));
    }

    const text = fs.readFileSync(platformFile, 'utf-8');
    lines = text.split('\n');

    // find :cap-otc-billing
    const subjectIri = 'https://spotify.net/id/fin/platform/cap-otc-billing';
    const loc = store.getDefinitionLocation(subjectIri);
    assert(loc, 'Should find cap-otc-billing in source map');
    subjectLine = loc.line;
    blockEnd = findBlockEnd(lines, subjectLine);

    console.log(`    Subject at line ${subjectLine}, block ends at ${blockEnd}`);
    console.log('    Block content:');
    for (let i = subjectLine; i <= blockEnd; i++) {
      console.log(`      ${i}: ${lines[i]}`);
    }
  });

  it('finds the predicate compact form in the block', function () {
    const predIri = 'https://spotify.net/ns/fin/platform#hasFeature';
    const predCompact = store.compact(predIri);
    const predLocal = store.localName(predIri);
    console.log(`    predCompact: "${predCompact}", predLocal: "${predLocal}"`);

    const blockText = lines.slice(subjectLine, blockEnd + 1).join('\n');
    assert(blockText.includes(predCompact) || blockText.includes(predLocal),
      `Block should contain "${predCompact}" or "${predLocal}"`);
  });

  it('builds matchers that include "Receipt Generation"', function () {
    const subjectIri = 'https://spotify.net/id/fin/platform/cap-otc-billing';
    const predIri = 'https://spotify.net/ns/fin/platform#hasFeature';
    const matchers = buildObjectMatchers(store, subjectIri, predIri, 'fake-blank-node-hash', 'Receipt Generation');
    console.log('    Matchers:', matchers);
    assert(matchers.includes('Receipt Generation'));
  });

  it('findDeleteTarget locates "Receipt Generation" line', function () {
    const predIri = 'https://spotify.net/ns/fin/platform#hasFeature';
    const predCompact = store.compact(predIri);
    const predLocal = store.localName(predIri);
    const matchers = ['Receipt Generation'];

    const result = findDeleteTarget(lines, subjectLine, blockEnd, predCompact, predLocal, matchers);
    console.log('    Delete target result:', result);
    if (result) {
      console.log('    Matched line:', lines[result.line]);
    }
    assert(result !== null, 'Should find the line with Receipt Generation');
  });

  it('findDeleteTarget locates "Invoice Generation" line', function () {
    const predIri = 'https://spotify.net/ns/fin/platform#hasFeature';
    const predCompact = store.compact(predIri);
    const predLocal = store.localName(predIri);
    const matchers = ['Invoice Generation'];

    const result = findDeleteTarget(lines, subjectLine, blockEnd, predCompact, predLocal, matchers);
    console.log('    Delete target result:', result);
    if (result) {
      console.log('    Matched line:', lines[result.line]);
    }
    assert(result !== null, 'Should find the line with Invoice Generation');
  });
});

describe('Delete: named IRI entity (providedBy)', function () {
  let store;
  let lines;
  let subjectLine;
  let blockEnd;

  before(function () {
    if (!fs.existsSync(platformFile)) { this.skip(); }
    store = new TestStore();
    const ttlFiles = fs.readdirSync(platformDir).filter(f => f.endsWith('.ttl'));
    for (const f of ttlFiles) {
      store.load(path.join(platformDir, f));
    }
    const text = fs.readFileSync(platformFile, 'utf-8');
    lines = text.split('\n');
    const loc = store.getDefinitionLocation('https://spotify.net/id/fin/platform/cap-otc-billing');
    subjectLine = loc.line;
    blockEnd = findBlockEnd(lines, subjectLine);
  });

  it('findDeleteTarget locates :prod-ark in providedBy', function () {
    const predIri = 'https://spotify.net/ns/fin/platform#providedBy';
    const predCompact = store.compact(predIri);
    const predLocal = store.localName(predIri);
    const objCompact = store.compact('https://spotify.net/id/fin/platform/prod-ark');
    const matchers = [objCompact, 'prod-ark'];

    console.log(`    predCompact: "${predCompact}", matchers: ${JSON.stringify(matchers)}`);
    const result = findDeleteTarget(lines, subjectLine, blockEnd, predCompact, predLocal, matchers);
    console.log('    Result:', result);
    if (result) { console.log('    Line:', lines[result.line]); }
    assert(result !== null, 'Should find prod-ark');
  });
});

describe('Add relationship: range inference for providedBy', function () {
  let store;

  before(function () {
    if (!fs.existsSync(platformDir)) { this.skip(); }
    store = new TestStore();
    const ttlFiles = fs.readdirSync(platformDir).filter(f => f.endsWith('.ttl'));
    for (const f of ttlFiles) {
      store.load(path.join(platformDir, f));
    }
  });

  it('infers Product as the range for providedBy', function () {
    const predIri = 'https://spotify.net/ns/fin/platform#providedBy';

    // strategy 1: declared range
    let range;
    const rangeRows = store.query(`SELECT ?range WHERE { <${predIri}> rdfs:range ?range } LIMIT 1`);
    range = rangeRows[0]?.get('range')?.value;
    console.log('    Declared range:', range);

    // strategy 2: inverse domain
    if (!range) {
      const invRows = store.query(`
        SELECT ?domain WHERE {
          ?inv owl:inverseOf <${predIri}> .
          ?inv rdfs:domain ?domain .
        } LIMIT 1
      `);
      range = invRows[0]?.get('domain')?.value;
      console.log('    Inverse domain:', range);
    }

    // strategy 3: usage
    if (!range) {
      const usageRows = store.query(`
        SELECT ?type (COUNT(?o) AS ?n) WHERE {
          ?s <${predIri}> ?o .
          ?o a ?type . ?type a owl:Class .
        } GROUP BY ?type ORDER BY DESC(?n) LIMIT 1
      `);
      range = usageRows[0]?.get('type')?.value;
      console.log('    Usage inferred:', range);
    }

    assert(range, 'Should find a range');
    assert(range.includes('Product'), `Range should be Product, got: ${range}`);
  });

  it('entity picker filtered by Product returns only products', function () {
    const range = 'https://spotify.net/ns/fin/platform#Product';
    const rows = store.query(`
      SELECT ?inst ?label WHERE {
        ?inst a <${range}> .
        OPTIONAL { ?inst rdfs:label ?label }
        FILTER(isIRI(?inst))
      } ORDER BY ?label LIMIT 200
    `);

    console.log(`    Products found: ${rows.length}`);
    for (const r of rows.slice(0, 5)) {
      console.log(`      ${r.get('label')?.value ?? store.localName(r.get('inst').value)}`);
    }
    assert(rows.length > 0, 'Should find Product entities');

    // verify they're all Products
    for (const r of rows) {
      const iri = r.get('inst').value;
      const typeCheck = store.query(`SELECT ?t WHERE { <${iri}> a <${range}> } LIMIT 1`);
      assert(typeCheck.length > 0, `${iri} should be a Product`);
    }
  });

  it('unfiltered entity picker (no range) returns too many types', function () {
    const rows = store.query(`
      SELECT ?inst ?label WHERE {
        ?inst rdfs:label ?label .
        FILTER(isIRI(?inst))
      } ORDER BY ?label LIMIT 200
    `);
    // collect types
    const types = new Set();
    for (const r of rows.slice(0, 20)) {
      const iri = r.get('inst').value;
      const tRows = store.query(`SELECT ?t WHERE { <${iri}> a ?t . ?t a owl:Class . } LIMIT 1`);
      if (tRows.length > 0) { types.add(store.localName(tRows[0].get('t').value)); }
    }
    console.log('    Types in unfiltered results:', [...types]);
    assert(types.size > 1, 'Unfiltered should return mixed types — this is the bug if range inference fails');
  });
});
