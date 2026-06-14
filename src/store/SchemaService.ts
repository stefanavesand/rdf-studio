import { RdfStore } from './RdfStore';

export interface PropertyDef {
  iri: string;
  label: string;
  isObject: boolean;
  domain: string | undefined;
  domainLabel: string | undefined;
  range: string | undefined;
  rangeLabel: string | undefined;
}

export interface ShaclConstraint {
  shapeName: string;
  path: string;
  pathLabel: string;
  minCount: number | undefined;
  maxCount: number | undefined;
  datatype: string | undefined;
  classRestriction: string | undefined;
  severity: 'violation' | 'warning';
  message: string;
}

export interface ShaclShape {
  iri: string;
  targetClass: string;
  constraints: ShaclConstraint[];
  orGroups: ShaclOrGroup[];
}

export interface ShaclOrGroup {
  shapeName: string;
  severity: 'violation' | 'warning';
  message: string;
  paths: { path: string; pathLabel: string }[];
}

export interface ValidationResult {
  violations: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ValidationIssue {
  path: string;
  pathLabel: string;
  message: string;
  severity: 'violation' | 'warning';
  expectedRange: string | undefined;
  expectedRangeLabel: string | undefined;
  isObject: boolean;
  kind: 'missing' | 'wrong-type' | 'or-group';
  orPaths?: string[];
}

export class SchemaService {
  constructor(private readonly store: RdfStore) {}

  getPropertiesForClass(classIri: string): PropertyDef[] {
    const rows = this.store.query(`
      SELECT DISTINCT ?p ?pLabel ?isObj ?domain ?domainLabel ?range ?rangeLabel WHERE {
        ?p a ?propType .
        FILTER(?propType IN (owl:ObjectProperty, owl:DatatypeProperty))
        BIND(?propType = owl:ObjectProperty AS ?isObj)
        OPTIONAL { ?p rdfs:domain ?domain }
        OPTIONAL { ?p rdfs:label ?pLabel }
        OPTIONAL { ?domain rdfs:label ?domainLabel }
        OPTIONAL { ?p rdfs:range ?range }
        OPTIONAL { ?range rdfs:label ?rangeLabel }
      }
    `);

    const superclasses = this.getSuperclasses(classIri);
    superclasses.add(classIri);

    const props: PropertyDef[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const p = row.get('p')!.value;
      if (seen.has(p)) { continue; }
      const domain = row.get('domain')?.value;
      if (domain && !superclasses.has(domain) && domain !== 'http://www.w3.org/2002/07/owl#Thing') {
        continue;
      }
      seen.add(p);
      props.push({
        iri: p,
        label: row.get('pLabel')?.value ?? this.store.localName(p),
        isObject: row.get('isObj')?.value === 'true',
        domain: domain,
        domainLabel: row.get('domainLabel')?.value ?? (domain ? this.store.localName(domain) : undefined),
        range: row.get('range')?.value,
        rangeLabel: row.get('rangeLabel')?.value ?? (row.get('range')?.value ? this.store.localName(row.get('range')!.value) : undefined),
      });
    }
    return props;
  }

  getShapesForClass(classIri: string): ShaclShape[] {
    const superclasses = this.getSuperclasses(classIri);
    superclasses.add(classIri);

    const shapeRows = this.store.query(`
      SELECT ?shape ?targetClass WHERE {
        ?shape a <http://www.w3.org/ns/shacl#NodeShape> ;
               <http://www.w3.org/ns/shacl#targetClass> ?targetClass .
      }
    `);

    const shapes: ShaclShape[] = [];
    for (const sr of shapeRows) {
      const targetClass = sr.get('targetClass')!.value;
      if (!superclasses.has(targetClass)) { continue; }

      const shapeIri = sr.get('shape')!.value;
      const constraints = this.getShapeConstraints(shapeIri);
      const orGroups = this.getShapeOrGroups(shapeIri);
      shapes.push({ iri: shapeIri, targetClass, constraints, orGroups });
    }
    return shapes;
  }

  validate(entityIri: string): ValidationResult {
    const typeRows = this.store.query(`
      SELECT ?type WHERE { <${entityIri}> a ?type . ?type a owl:Class . }
    `);

    const violations: ValidationIssue[] = [];
    const warnings: ValidationIssue[] = [];

    for (const tr of typeRows) {
      const classIri = tr.get('type')!.value;
      const shapes = this.getShapesForClass(classIri);
      const props = this.getPropertiesForClass(classIri);
      const propMap = new Map(props.map(p => [p.iri, p]));

      for (const shape of shapes) {
        for (const c of shape.constraints) {
          if (c.minCount !== undefined && c.minCount > 0) {
            const count = this.countProperty(entityIri, c.path);
            if (count < c.minCount) {
              const prop = propMap.get(c.path);
              const issue: ValidationIssue = {
                path: c.path,
                pathLabel: c.pathLabel,
                message: c.message,
                severity: c.severity,
                expectedRange: c.classRestriction ?? c.datatype ?? prop?.range,
                expectedRangeLabel: c.classRestriction
                  ? this.store.localName(c.classRestriction)
                  : c.datatype
                    ? this.store.localName(c.datatype)
                    : prop?.rangeLabel,
                isObject: prop?.isObject ?? (c.classRestriction !== undefined),
                kind: 'missing',
              };
              if (c.severity === 'violation') { violations.push(issue); }
              else { warnings.push(issue); }
            }
          }

          if (c.datatype) {
            const values = this.getPropertyValues(entityIri, c.path);
            for (const v of values) {
              if (v.termType === 'Literal' && v.datatype && v.datatype !== c.datatype) {
                const prop = propMap.get(c.path);
                const issue: ValidationIssue = {
                  path: c.path,
                  pathLabel: c.pathLabel,
                  message: `Expected ${this.store.localName(c.datatype)}, got ${this.store.localName(v.datatype)}`,
                  severity: c.severity,
                  expectedRange: c.datatype,
                  expectedRangeLabel: this.store.localName(c.datatype),
                  isObject: false,
                  kind: 'wrong-type',
                };
                if (c.severity === 'violation') { violations.push(issue); }
                else { warnings.push(issue); }
              }
            }
          }
        }

        for (const og of shape.orGroups) {
          const satisfied = og.paths.some(p => this.countProperty(entityIri, p.path) > 0);
          if (!satisfied) {
            const issue: ValidationIssue = {
              path: og.paths[0]?.path ?? '',
              pathLabel: og.paths.map(p => p.pathLabel).join(' / '),
              message: og.message,
              severity: og.severity,
              expectedRange: undefined,
              expectedRangeLabel: undefined,
              isObject: true,
              kind: 'or-group',
              orPaths: og.paths.map(p => p.pathLabel),
            };
            if (og.severity === 'violation') { violations.push(issue); }
            else { warnings.push(issue); }
          }
        }
      }
    }

    return { violations, warnings };
  }

  getClassComment(classIri: string): string | undefined {
    return this.store.getComment(classIri);
  }

  getSuperclassChain(classIri: string): string[] {
    const chain: string[] = [];
    const visited = new Set<string>();
    let current = classIri;
    while (true) {
      const rows = this.store.query(`
        SELECT ?parent WHERE {
          <${current}> rdfs:subClassOf ?parent .
          ?parent a owl:Class .
        } LIMIT 1
      `);
      if (rows.length === 0) { break; }
      const parent = rows[0].get('parent')!.value;
      if (visited.has(parent)) { break; }
      visited.add(parent);
      chain.push(parent);
      current = parent;
    }
    return chain;
  }

  private getSuperclasses(classIri: string): Set<string> {
    const result = new Set<string>();
    const queue = [classIri];
    while (queue.length > 0) {
      const current = queue.pop()!;
      if (result.has(current)) { continue; }
      result.add(current);
      const rows = this.store.query(`
        SELECT ?parent WHERE {
          <${current}> rdfs:subClassOf ?parent .
          ?parent a owl:Class .
        } LIMIT 10
      `);
      for (const r of rows) {
        const parent = r.get('parent')!.value;
        if (!result.has(parent)) { queue.push(parent); }
      }
    }
    return result;
  }

  private getShapeConstraints(shapeIri: string): ShaclConstraint[] {
    const rows = this.store.query(`
      SELECT ?prop ?path ?pathLabel ?minCount ?maxCount ?datatype ?class ?severity ?message WHERE {
        <${shapeIri}> <http://www.w3.org/ns/shacl#property> ?prop .
        ?prop <http://www.w3.org/ns/shacl#path> ?path .
        OPTIONAL { ?path rdfs:label ?pathLabel }
        OPTIONAL { ?prop <http://www.w3.org/ns/shacl#minCount> ?minCount }
        OPTIONAL { ?prop <http://www.w3.org/ns/shacl#maxCount> ?maxCount }
        OPTIONAL { ?prop <http://www.w3.org/ns/shacl#datatype> ?datatype }
        OPTIONAL { ?prop <http://www.w3.org/ns/shacl#class> ?class }
        OPTIONAL { ?prop <http://www.w3.org/ns/shacl#severity> ?severity }
        OPTIONAL { ?prop <http://www.w3.org/ns/shacl#message> ?message }
      }
    `);

    const shapeSeverityRows = this.store.query(`
      SELECT ?severity WHERE {
        <${shapeIri}> <http://www.w3.org/ns/shacl#severity> ?severity .
      } LIMIT 1
    `);
    const shapeSeverity = shapeSeverityRows[0]?.get('severity')?.value;
    const defaultSeverity = shapeSeverity?.endsWith('Warning') ? 'warning' as const : 'violation' as const;

    return rows.map(row => {
      const propSeverity = row.get('severity')?.value;
      const severity = propSeverity
        ? (propSeverity.endsWith('Warning') ? 'warning' as const : 'violation' as const)
        : defaultSeverity;

      const minVal = row.get('minCount')?.value;
      const maxVal = row.get('maxCount')?.value;

      return {
        shapeName: this.store.localName(shapeIri),
        path: row.get('path')!.value,
        pathLabel: row.get('pathLabel')?.value ?? this.store.localName(row.get('path')!.value),
        minCount: minVal !== undefined ? parseInt(minVal, 10) : undefined,
        maxCount: maxVal !== undefined ? parseInt(maxVal, 10) : undefined,
        datatype: row.get('datatype')?.value,
        classRestriction: row.get('class')?.value,
        severity,
        message: row.get('message')?.value ?? '',
      };
    });
  }

  private getShapeOrGroups(shapeIri: string): ShaclOrGroup[] {
    const hasOr = this.store.query(`
      SELECT ?dummy WHERE {
        <${shapeIri}> <http://www.w3.org/ns/shacl#or> ?list .
      } LIMIT 1
    `);
    if (hasOr.length === 0) { return []; }

    const msgRows = this.store.query(`
      SELECT ?message ?severity WHERE {
        <${shapeIri}> <http://www.w3.org/ns/shacl#message> ?message .
        OPTIONAL { <${shapeIri}> <http://www.w3.org/ns/shacl#severity> ?severity }
      } LIMIT 1
    `);

    const pathRows = this.store.query(`
      SELECT ?path ?pathLabel WHERE {
        <${shapeIri}> <http://www.w3.org/ns/shacl#or> ?list .
        ?list rdf:rest*/rdf:first ?item .
        ?item <http://www.w3.org/ns/shacl#path> ?path .
        OPTIONAL { ?path rdfs:label ?pathLabel }
      }
    `);

    if (pathRows.length === 0) { return []; }

    const sevVal = msgRows[0]?.get('severity')?.value;
    const severity = sevVal?.endsWith('Warning') ? 'warning' as const : 'violation' as const;

    return [{
      shapeName: this.store.localName(shapeIri),
      severity,
      message: msgRows[0]?.get('message')?.value ?? '',
      paths: pathRows.map(r => ({
        path: r.get('path')!.value,
        pathLabel: r.get('pathLabel')?.value ?? this.store.localName(r.get('path')!.value),
      })),
    }];
  }

  private countProperty(entityIri: string, propertyIri: string): number {
    const rows = this.store.query(`
      SELECT (COUNT(?o) AS ?n) WHERE { <${entityIri}> <${propertyIri}> ?o }
    `);
    return parseInt(rows[0]?.get('n')?.value ?? '0', 10);
  }

  private getPropertyValues(entityIri: string, propertyIri: string): { value: string; termType: string; datatype?: string }[] {
    const rows = this.store.query(`
      SELECT ?o WHERE { <${entityIri}> <${propertyIri}> ?o }
    `);
    return rows.map(r => {
      const o = r.get('o')!;
      return {
        value: o.value,
        termType: o.termType,
        datatype: (o as any).datatype?.value,
      };
    });
  }
}
