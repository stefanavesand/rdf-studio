const ox = require('oxigraph');
const fs = require('fs');
const path = require('path');

const store = new ox.Store();
const dir = path.join(__dirname, '../../../domains/fine-platform/knowledge/platform-kg/model');
const prefixes = new Map();

for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.ttl'))) {
  const text = fs.readFileSync(path.join(dir, f), 'utf-8');
  const rx = /@prefix\s+(\w*)\s*:\s*<([^>]+)>\s*\./g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    prefixes.set(m[1], m[2]);
  }
  store.load(text, { format: 'text/turtle' }, undefined, undefined);
}

const h = [
  'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
  'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
  'PREFIX owl: <http://www.w3.org/2002/07/owl#>',
  'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
];
for (const [p, n] of prefixes) {
  h.push(`PREFIX ${p}: <${n}>`);
}
const hdr = h.join('\n') + '\n';

const classIri = 'https://spotify.net/ns/fin/platform#Capability';

console.log('=== Properties with domain = Capability ===');
const rows = store.query(hdr + `
  SELECT ?p ?pLabel ?range ?rangeLabel ?propType WHERE {
    ?p rdfs:domain <${classIri}> .
    ?p a ?propType .
    FILTER(?propType IN (owl:ObjectProperty, owl:DatatypeProperty))
    OPTIONAL { ?p rdfs:label ?pLabel }
    OPTIONAL { ?p rdfs:range ?range }
    OPTIONAL { ?range rdfs:label ?rangeLabel }
  } ORDER BY ?pLabel
`, undefined);

for (const r of rows) {
  const p = r.get('pLabel')?.value || r.get('p').value;
  const range = r.get('rangeLabel')?.value || r.get('range')?.value || 'NONE';
  console.log(`  ${p} -> ${range}`);
}
console.log(`Total rows: ${rows.length}`);

// check how many distinct properties
const distinct = new Set(rows.map(r => r.get('p').value));
console.log(`Distinct properties: ${distinct.size}`);
