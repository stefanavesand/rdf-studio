import * as vscode from 'vscode';
import * as oxigraph from 'oxigraph';

type Term = { value: string; termType: string };
type Row = Map<string, Term>;

export interface ClassInfo {
  iri: string;
  label: string;
  instanceCount: number;
  subClasses: ClassInfo[];
}

export interface PropertyInfo {
  predicate: string;
  predicateLabel: string;
  values: { value: string; label: string; isIri: boolean }[];
}

export interface InstanceInfo {
  iri: string;
  label: string;
  types: string[];
}

export class RdfStore {
  private store: oxigraph.Store | null = null;
  private prefixes = new Map<string, string>();
  private sourceMap = new Map<string, { uri: vscode.Uri; line: number }>();

  private readonly _onDidReload = new vscode.EventEmitter<void>();
  readonly onDidReload = this._onDidReload.event;

  get isLoaded(): boolean {
    return this.store !== null;
  }

  get tripleCount(): number {
    return this.store?.size ?? 0;
  }

  async load(files: vscode.Uri[]): Promise<void> {
    this.store = new oxigraph.Store();
    this.prefixes.clear();
    this.sourceMap.clear();

    for (const file of files) {
      try {
        const bytes = await vscode.workspace.fs.readFile(file);
        const text = Buffer.from(bytes).toString('utf-8');
        this.parsePrefixes(text);
        this.buildSourceMap(text, file);
        this.store.load(text, { format: 'text/turtle' }, undefined, undefined);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showWarningMessage(`Failed to load ${file.fsPath}: ${msg}`);
      }
    }

    this._onDidReload.fire();
  }

  query(sparql: string): Row[] {
    if (!this.store) { return []; }
    const prefixHeader = this.buildPrefixHeader();
    const result = this.store.query(prefixHeader + sparql, undefined);
    if (Array.isArray(result)) {
      return result as Row[];
    }
    return [];
  }

  private static readonly SKIP_NS = [
    'http://www.w3.org/2002/07/owl#',
    'http://www.w3.org/2000/01/rdf-schema#',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'http://www.w3.org/2001/XMLSchema#',
    'http://www.w3.org/2004/02/skos/core#',
    'http://www.w3.org/ns/shacl#',
  ];

  private isStandardClass(iri: string): boolean {
    return RdfStore.SKIP_NS.some(ns => iri.startsWith(ns));
  }

  getClassHierarchy(): ClassInfo[] {
    const rows = this.query(`
      SELECT ?cls ?label ?parent WHERE {
        ?cls a owl:Class .
        OPTIONAL { ?cls rdfs:subClassOf ?parent .
                   ?parent a owl:Class . }
        OPTIONAL { ?cls rdfs:label ?label }
      }
    `);

    // batch count all instances per class in one query
    const countRows = this.query(`
      SELECT ?cls (COUNT(DISTINCT ?inst) AS ?n) WHERE {
        ?inst a ?cls .
        ?cls a owl:Class .
        FILTER(isIRI(?inst))
      } GROUP BY ?cls
    `);
    const counts = new Map<string, number>();
    for (const r of countRows) {
      counts.set(r.get('cls')!.value, parseInt(r.get('n')?.value ?? '0', 10));
    }

    const classMap = new Map<string, { iri: string; label: string; parents: Set<string> }>();
    for (const row of rows) {
      const cls = row.get('cls')!.value;
      if (this.isStandardClass(cls)) { continue; }
      const label = row.get('label')?.value ?? this.localName(cls);
      const parent = row.get('parent')?.value;
      if (!classMap.has(cls)) {
        classMap.set(cls, { iri: cls, label, parents: new Set() });
      }
      if (parent && !this.isStandardClass(parent)) {
        classMap.get(cls)!.parents.add(parent);
      }
    }

    const buildNode = (iri: string): ClassInfo => {
      const info = classMap.get(iri)!;
      const children = [...classMap.entries()]
        .filter(([, v]) => v.parents.has(iri))
        .map(([k]) => buildNode(k))
        .sort((a, b) => a.label.localeCompare(b.label));
      return {
        iri,
        label: info.label,
        instanceCount: counts.get(iri) ?? 0,
        subClasses: children,
      };
    };

    const roots = [...classMap.keys()].filter(cls => {
      const info = classMap.get(cls)!;
      return info.parents.size === 0 || [...info.parents].every(p => !classMap.has(p));
    });

    return roots.map(buildNode).sort((a, b) => a.label.localeCompare(b.label));
  }

  getInstances(classIri: string): InstanceInfo[] {
    const rows = this.query(`
      SELECT DISTINCT ?inst ?label WHERE {
        ?inst a <${classIri}> .
        OPTIONAL { ?inst rdfs:label ?label }
        FILTER(isIRI(?inst))
      } ORDER BY ?label LIMIT 500
    `);

    return rows.map(row => ({
      iri: row.get('inst')!.value,
      label: row.get('label')?.value ?? this.localName(row.get('inst')!.value),
      types: [],
    }));
  }

  getOutgoing(iri: string): PropertyInfo[] {
    const rows = this.query(`
      SELECT ?p ?pLabel ?o ?oLabel WHERE {
        <${iri}> ?p ?o .
        OPTIONAL { ?p rdfs:label ?pLabel }
        OPTIONAL { ?o rdfs:label ?oLabel }
        FILTER(?p != rdf:type && ?p != rdfs:subClassOf && ?p != owl:imports
               && ?p != rdfs:subPropertyOf && ?p != rdfs:domain && ?p != rdfs:range)
      } ORDER BY ?p
    `);

    return this.groupByPredicate(rows);
  }

  getIncoming(iri: string): PropertyInfo[] {
    const rows = this.query(`
      SELECT ?s ?sLabel ?p ?pLabel WHERE {
        ?s ?p <${iri}> .
        OPTIONAL { ?s rdfs:label ?sLabel }
        OPTIONAL { ?p rdfs:label ?pLabel }
        FILTER(?p != rdf:type && ?p != rdfs:subClassOf)
        FILTER(isIRI(?s))
      } ORDER BY ?p
    `);

    const grouped = new Map<string, PropertyInfo>();
    for (const row of rows) {
      const pred = row.get('p')!.value;
      const predLabel = row.get('pLabel')?.value ?? this.localName(pred);
      if (!grouped.has(pred)) {
        grouped.set(pred, { predicate: pred, predicateLabel: predLabel, values: [] });
      }
      const s = row.get('s')!;
      grouped.get(pred)!.values.push({
        value: s.value,
        label: row.get('sLabel')?.value ?? this.localName(s.value),
        isIri: true,
      });
    }
    return [...grouped.values()];
  }

  getLabel(iri: string): string | undefined {
    const rows = this.query(`
      SELECT ?label WHERE {
        <${iri}> rdfs:label ?label
      } LIMIT 1
    `);
    return rows[0]?.get('label')?.value;
  }

  getComment(iri: string): string | undefined {
    const rows = this.query(`
      SELECT ?comment WHERE {
        <${iri}> rdfs:comment ?comment
      } LIMIT 1
    `);
    return rows[0]?.get('comment')?.value;
  }

  getTypes(iri: string): string[] {
    const rows = this.query(`
      SELECT ?type ?label WHERE {
        <${iri}> a ?type .
        OPTIONAL { ?type rdfs:label ?label }
      }
    `);
    return rows.map(r => r.get('label')?.value ?? this.localName(r.get('type')!.value));
  }

  getDefinitionLocation(iri: string): { uri: vscode.Uri; line: number } | undefined {
    return this.sourceMap.get(iri);
  }

  getPrefixes(): Map<string, string> {
    return new Map(this.prefixes);
  }

  localName(iri: string): string {
    const parts = iri.split(/[#/]/);
    return parts[parts.length - 1] || iri;
  }

  compact(iri: string): string {
    for (const [prefix, ns] of this.prefixes) {
      if (iri.startsWith(ns)) {
        const local = iri.slice(ns.length);
        return prefix ? `${prefix}:${local}` : `:${local}`;
      }
    }
    return this.localName(iri);
  }

  private countInstances(classIri: string): number {
    const rows = this.query(`
      SELECT (COUNT(DISTINCT ?inst) AS ?count) WHERE {
        ?inst a <${classIri}> .
        FILTER(isIRI(?inst))
      }
    `);
    const val = rows[0]?.get('count')?.value;
    return val ? parseInt(val, 10) : 0;
  }

  private groupByPredicate(rows: Row[]): PropertyInfo[] {
    const grouped = new Map<string, PropertyInfo>();
    for (const row of rows) {
      const pred = row.get('p')!.value;
      const predLabel = row.get('pLabel')?.value ?? this.localName(pred);
      if (!grouped.has(pred)) {
        grouped.set(pred, { predicate: pred, predicateLabel: predLabel, values: [] });
      }
      const o = row.get('o')!;
      const isIri = o.termType === 'NamedNode' || o.termType === 'BlankNode';
      const oLabel = row.get('oLabel')?.value;
      grouped.get(pred)!.values.push({
        value: o.value,
        label: oLabel ?? (o.termType === 'NamedNode' ? this.localName(o.value) : o.value),
        isIri,
      });
    }
    return [...grouped.values()];
  }

  private parsePrefixes(text: string): void {
    const regex = /@prefix\s+(\w*)\s*:\s*<([^>]+)>\s*\./g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      this.prefixes.set(m[1], m[2]);
    }
  }

  private buildSourceMap(text: string, file: vscode.Uri): void {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prefixed = line.match(/^:(\S+)/);
      if (prefixed) {
        const ns = this.prefixes.get('') ?? 'https://spotify.net/id/fin/ar/';
        const local = prefixed[1].replace(/\s.*$/, '');
        this.sourceMap.set(ns + local, { uri: file, line: i });
        continue;
      }
      const nsPrefixed = line.match(/^(\w+):(\S+)/);
      if (nsPrefixed && !line.startsWith('@') && !line.startsWith('#')) {
        const ns = this.prefixes.get(nsPrefixed[1]);
        if (ns) {
          const local = nsPrefixed[2].replace(/\s.*$/, '');
          this.sourceMap.set(ns + local, { uri: file, line: i });
        }
      }
    }
  }

  private buildPrefixHeader(): string {
    const lines = [
      'PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>',
      'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
      'PREFIX owl: <http://www.w3.org/2002/07/owl#>',
      'PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>',
      'PREFIX skos: <http://www.w3.org/2004/02/skos/core#>',
    ];
    for (const [prefix, ns] of this.prefixes) {
      lines.push(`PREFIX ${prefix}: <${ns}>`);
    }
    return lines.join('\n') + '\n';
  }

  dispose(): void {
    this._onDidReload.dispose();
  }
}
