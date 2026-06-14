const ox = require('oxigraph');
const fs = require('fs');
const path = require('path');

const store = new ox.Store();
const dir = path.join(__dirname, '../../../domains/fine-platform/knowledge/platform-kg/model');
const prefixes = new Map();

for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.ttl'))) {
  const text = fs.readFileSync(path.join(dir, f), 'utf-8');
  const regex = /@prefix\s+(\w*)\s*:\s*<([^>]+)>\s*\./g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    prefixes.set(m[1], m[2]);
  }
  store.load(text, { format: 'text/turtle' }, undefined, undefined);
}

const header = [
  'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
  'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
  'PREFIX owl: <http://www.w3.org/2002/07/owl#>',
  'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
];
for (const [p, n] of prefixes) {
  header.push(`PREFIX ${p}: <${n}>`);
}
const h = header.join('\n') + '\n';

// what the predicate picker returns for providedBy
const preds = store.query(h + `
  SELECT DISTINCT ?p ?pLabel WHERE {
    ?s ?p ?o .
    FILTER(?p != rdf:type && ?p != rdfs:subClassOf && ?p != owl:imports)
    OPTIONAL { ?p rdfs:label ?pLabel }
  } ORDER BY ?pLabel LIMIT 200
`, undefined);

const pb = preds.filter(r => r.get('p').value.includes('providedBy'));
console.log('Predicates matching providedBy:');
for (const r of pb) {
  console.log('  IRI:', r.get('p').value, '  label:', r.get('pLabel')?.value);
}

// range query for that IRI
if (pb.length > 0) {
  const iri = pb[0].get('p').value;
  const rangeRows = store.query(h + `SELECT ?range WHERE { <${iri}> rdfs:range ?range } LIMIT 1`, undefined);
  console.log('Range for', iri, ':', rangeRows[0]?.get('range')?.value || 'NONE');

  if (rangeRows[0]) {
    const range = rangeRows[0].get('range').value;
    const entities = store.query(h + `
      SELECT ?inst ?label WHERE {
        ?inst a <${range}> .
        OPTIONAL { ?inst rdfs:label ?label }
        FILTER(isIRI(?inst))
      } ORDER BY ?label LIMIT 5
    `, undefined);
    console.log(`Entities of type ${range}: ${entities.length}`);
    for (const e of entities) {
      console.log('  ', e.get('label')?.value || e.get('inst').value);
    }
  }
} else {
  console.log('providedBy not found in predicates!');
}
