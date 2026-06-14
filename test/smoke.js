const fs = require('fs');
const path = require('path');
const ox = require('oxigraph');

const modelDir = path.join(__dirname, '../../../domains/revenue-platform/knowledge/ar-subledger-kg/model');
const files = fs.readdirSync(modelDir).filter(f => f.endsWith('.ttl'));

const store = new ox.Store();
for (const f of files) {
  const text = fs.readFileSync(path.join(modelDir, f), 'utf-8');
  store.load(text, { format: 'text/turtle' }, undefined, undefined);
  console.log(`  loaded ${f}`);
}
console.log(`\nTotal triples: ${store.size}`);

const classes = store.query(
  'PREFIX owl: <http://www.w3.org/2002/07/owl#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ' +
  'PREFIX ar: <https://spotify.net/ns/fin/ar#> ' +
  'SELECT (COUNT(?cls) AS ?n) WHERE { ?cls a owl:Class . FILTER(STRSTARTS(STR(?cls), STR(ar:))) }',
  undefined
);
console.log(`OWL classes (ar: namespace): ${classes[0].get('n').value}`);

const instances = store.query(
  'PREFIX ar: <https://spotify.net/ns/fin/ar#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> ' +
  'SELECT ?cls ?label (COUNT(?inst) AS ?n) WHERE { ' +
  '  ?inst a ?cls . ?cls a <http://www.w3.org/2002/07/owl#Class> . ' +
  '  FILTER(STRSTARTS(STR(?cls), STR(ar:))) ' +
  '  OPTIONAL { ?cls rdfs:label ?label } ' +
  '} GROUP BY ?cls ?label ORDER BY DESC(?n) LIMIT 10',
  undefined
);
console.log('\nTop 10 classes by instance count:');
for (const row of instances) {
  const label = row.get('label')?.value ?? row.get('cls').value.split('#').pop();
  console.log(`  ${label}: ${row.get('n').value}`);
}

console.log('\n✓ Oxigraph smoke test passed');
