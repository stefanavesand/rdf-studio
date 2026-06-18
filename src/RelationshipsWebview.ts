import * as vscode from 'vscode';
import * as path from 'path';
import { RdfStore } from './store/RdfStore';
import { SchemaService, ValidationResult, PropertyDef, ShaclShape, ShaclConstraint } from './store/SchemaService';
import { hueFor } from './typeColors';

interface GroupedEdge {
  relation: string;
  relationLabel: string;
  items: { iri: string; label: string; type: string }[];
}

interface Field {
  name: string;
  predIri: string;
  valueType: string;
  value: string;
}

export class RelationshipsWebview implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private selectedIri: string | undefined;
  private selectedMode: 'instance' | 'class' | 'namespace' = 'instance';
  private selectedNsLabel: string | undefined;
  private schema: SchemaService;
  private extensionUri: vscode.Uri | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly store: RdfStore) {
    this.schema = new SchemaService(store);
    this.disposables.push(store.onDidReload(() => {
      this.schema = new SchemaService(store);
      this.refresh();
    }));
  }

  setExtensionUri(uri: vscode.Uri): void {
    this.extensionUri = uri;
  }

  resolveWebviewView(wv: vscode.WebviewView): void {
    this.view = wv;
    wv.webview.options = {
      enableScripts: true,
      localResourceRoots: this.extensionUri ? [vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')] : [],
    };
    wv.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'navigate') {
        vscode.commands.executeCommand('kgExplorer.showProperties', msg.iri);
      } else if (msg.type === 'goToDefinition') {
        vscode.commands.executeCommand('kgExplorer.goToDefinition', msg.iri);
      } else if (msg.type === 'delete') {
        vscode.commands.executeCommand('kgExplorer.deleteTriple', msg.subject, msg.predicate, msg.object, msg.label);
      } else if (msg.type === 'addProperty') {
        vscode.commands.executeCommand('kgExplorer.addProperty', msg.subject, msg.predicate, msg.range, msg.isObject);
      } else if (msg.type === 'editRelationship') {
        vscode.commands.executeCommand('kgExplorer.prepareEditRelationship', msg.subject, msg.predicate, msg.oldValue, msg.oldLabel, msg.dir);
      } else if (msg.type === 'addRelationship') {
        vscode.commands.executeCommand('kgExplorer.prepareAddRelationship', msg.subject);
      } else if (msg.type === 'editValue') {
        vscode.commands.executeCommand('kgExplorer.editValue', msg.subject, msg.predicate, msg.oldValue, msg.newValue);
      } else if (msg.type === 'undo') {
        vscode.commands.executeCommand('undo');
      } else if (msg.type === 'showEditForm') {
        this.showForm({ type: msg.editType, iri: msg.iri, ns: msg.iri, label: msg.label, comment: msg.comment });
      } else if (msg.type === 'saveEdit') {
        vscode.commands.executeCommand('kgExplorer.saveEdit', msg.editType, msg.iri, msg.label, msg.comment, msg.ns);
      } else if (msg.type === 'newInst') {
        vscode.commands.executeCommand('kgExplorer.newInstance', { kind: 'class', data: { iri: msg.classIri, label: msg.className } });
      } else if (msg.type === 'newProp') {
        vscode.commands.executeCommand('kgExplorer.newProperty', { kind: 'class', data: { iri: msg.classIri, label: msg.className } });
      } else if (msg.type === 'commitEditRel') {
        vscode.commands.executeCommand('kgExplorer.commitEditRelationship', msg.subject, msg.predicate, msg.oldValue, msg.newValue, msg.oldLabel);
      } else if (msg.type === 'searchEditRel') {
        vscode.commands.executeCommand('kgExplorer.searchForEditForm', msg.query, msg.targetType);
      } else if (msg.type === 'createProperty') {
        vscode.commands.executeCommand('kgExplorer.commitNewProperty', msg.name, msg.label, msg.kind, msg.range, msg.classIri);
      } else if (msg.type === 'createOntology') {
        vscode.commands.executeCommand('kgExplorer.commitNewOntology', msg.name, msg.prefix, msg.ns, msg.desc, msg.file);
      } else if (msg.type === 'createClass') {
        vscode.commands.executeCommand('kgExplorer.commitNewClass', msg.name, msg.label, msg.comment, msg.ns, msg.superclass);
      } else if (msg.type === 'createInstance') {
        vscode.commands.executeCommand('kgExplorer.commitNewInstance', msg.localName, msg.label, msg.classIri);
      } else if (msg.type === 'newClass') {
        // Fetch classes for superclass picker
        const classRows = this.store.query(`
          SELECT DISTINCT ?cls ?label WHERE {
            ?cls a owl:Class .
            OPTIONAL { ?cls rdfs:label ?label }
          } ORDER BY ?label LIMIT 200
        `);
        const seen = new Set<string>();
        const classes = classRows
          .filter(r => { const i = r.get('cls')!.value; if (seen.has(i)) { return false; } seen.add(i); return !i.startsWith('http://www.w3.org/'); })
          .map(r => {
            const iri = r.get('cls')!.value;
            const label = r.get('label')?.value ?? this.store.localName(iri);
            const compact = this.store.compact(iri);
            const prefix = compact.includes(':') ? compact.split(':')[0] + ':' : '';
            return { iri, label: prefix ? `${label} (${prefix})` : label };
          });
        this.showForm({ type: 'newClass', ns: msg.ns, classes });
      } else if (msg.type === 'newProperty') {
        vscode.commands.executeCommand('kgExplorer.newProperty', msg.ns);
      } else if (msg.type === 'addImport') {
        vscode.commands.executeCommand('kgExplorer.addImport', msg.ns);
      } else if (msg.type === 'removeImport') {
        vscode.commands.executeCommand('kgExplorer.removeImport', msg.ns, msg.import);
      } else if (msg.type === 'commitAddRel') {
        vscode.commands.executeCommand('kgExplorer.commitAddRel', msg.subject, msg.predicate, msg.value, msg.isObject);
      } else if (msg.type === 'pickEntity') {
        vscode.commands.executeCommand('kgExplorer.pickEntityForForm', msg.subject, msg.predicate, msg.range);
      }
    });
    wv.onDidChangeVisibility(() => {
      if (wv.visible) { this.refresh(); }
    });
    wv.onDidDispose(() => { this.view = undefined; });
    this.refresh();
  }

  private isRemote = false;

  select(iri: string, isClass = false, remote = false): void {
    this.selectedIri = iri;
    this.selectedMode = isClass ? 'class' : 'instance';
    this.isRemote = remote;
    this.refresh();
  }

  async selectRemote(iri: string, endpointUrl: string): Promise<void> {
    this.selectedIri = iri;
    this.selectedMode = 'instance';
    this.isRemote = true;
    // Show loading state
    if (this.view) {
      try {
        let label = this.store.getLabel(iri) ?? this.store.localName(iri);
        try { label = decodeURIComponent(label); } catch { /* */ }
        this.view.webview.html = this.wrap(`<div style="padding:20px 14px;text-align:center;color:var(--fg-muted)"><span class="codicon codicon-loading codicon-modifier-spin" style="font-size:24px"></span><p style="margin-top:12px">Loading ${esc(label)}...</p></div>`);
      } catch { /* */ }
    }
    // Fetch triples about this entity from the remote endpoint
    try {
      await this.store.fetchRemoteEntity(iri, endpointUrl);
    } catch { /* render with whatever we have */ }
    this.refresh();
  }

  showForm(form: { type: string; [key: string]: unknown }): void {
    if (!this.view) { return; }
    this.view.webview.postMessage({ type: 'showForm', form });
  }

  selectNamespace(ns: string, label: string): void {
    this.selectedIri = ns;
    this.selectedNsLabel = label;
    this.selectedMode = 'namespace';
    this.refresh();
  }

  private refresh(): void {
    if (!this.view || !this.view.visible) { return; }
    try {
      let html: string;
      switch (this.selectedMode) {
        case 'namespace': html = this.renderNamespace(); break;
        case 'class': html = this.renderSchema(); break;
        default: html = this.renderInstance(); break;
      }
      this.view.webview.html = html;
    } catch (e) {
      console.error('RelationshipsWebview render error:', e);
      try { this.view.webview.html = this.wrap(`<p class="empty">Error rendering view</p>`); } catch { /* */ }
    }
  }

  // ==================== INSTANCE VIEW ====================

  private renderInstance(): string {
    if (!this.selectedIri || !this.store.isLoaded) {
      return this.wrap('<p class="empty">Select an entity to see its relations</p>');
    }

    const iri = this.selectedIri;
    let label = this.store.getLabel(iri) ?? this.store.localName(iri);
    try { label = decodeURIComponent(label); } catch { /* */ }
    const types = this.store.getTypes(iri);
    const focusType = types[0] ?? 'Resource';
    const focusHue = hueFor(focusType);

    const fields = this.getFields(iri);
    const outGroups = this.buildGroups(iri, 'out');
    const inGroups = this.buildGroups(iri, 'in');
    const relCount = outGroups.reduce((n, g) => n + g.items.length, 0)
      + inGroups.reduce((n, g) => n + g.items.length, 0);

    const validation: import('./store/SchemaService').ValidationResult = { violations: [], warnings: [] };
    const issueCount = 0;

    const readonly = this.isRemote;
    let h = '';

    // breadcrumb
    h += `<div class="crumb-strip">`;
    h += `<span class="crumb-kind">${readonly ? 'REMOTE' : 'INSTANCE'}</span>`;
    h += `<a class="crumb-pill" style="--h:${focusHue}" data-iri="${esc(iri)}"><span class="crumb-dot" style="--h:${focusHue}"></span><span class="crumb-name" style="--h:${focusHue}">${esc(label)}</span></a>`;
    h += `<span class="codicon codicon-chevron-right" style="font-size:13px;color:var(--fg-muted)"></span>`;
    h += `<span class="crumb-parent">${esc(focusType)}</span>`;
    if (!readonly) {
      h += `<span style="margin-left:auto" class="crumb-edit codicon codicon-edit" data-action="editEntity" data-iri="${esc(iri)}" data-label="${esc(label)}" data-comment="${esc(this.store.getComment(iri) ?? '')}" title="Edit entity"></span>`;
    }
    h += `</div>`;

    // validation banner
    if (issueCount > 0) {
      h += `<div class="val-banner val-fail">`;
      h += `<span class="codicon codicon-error" style="font-size:15px;color:var(--err)"></span>`;
      h += `<span class="val-title">Fails validation</span>`;
      if (validation.violations.length > 0) {
        h += `<span class="val-pill viol-pill">${validation.violations.length} Violation${validation.violations.length > 1 ? 's' : ''}</span>`;
      }
      if (validation.warnings.length > 0) {
        h += `<span class="val-pill warn-pill">${validation.warnings.length} Warning${validation.warnings.length > 1 ? 's' : ''}</span>`;
      }
      h += `</div>`;
    }

    // counts
    h += `<div class="counts">${relCount} relations · ${fields.length} parameters on <span class="accent">this</span> entity</div>`;

    // column headers
    h += `<div class="col-headers"><div class="c-src">Source</div><div class="c-rel">Relation</div><div class="c-tgt">Target</div></div>`;

    // parameters
    if (fields.length > 0 || this.getMissingParams(iri, validation).length > 0) {
      h += `<div class="tbl" style="margin-bottom:8px">`;
      h += this.divider('param', 'Parameters', 'named values on this entity', fields.length);
      for (const f of fields) {
        h += this.paramRow(focusType, focusHue, f);
      }
      for (const issue of this.getMissingParams(iri, validation)) {
        h += this.ghostRow(focusType, focusHue, issue.pathLabel, issue.severity,
          issue.expectedRangeLabel ?? 'value', issue.isObject, issue.message, issue.path, issue.expectedRange);
      }
      h += `</div>`;
    }

    // outgoing
    const missingOut = this.getMissingOutgoing(iri, validation);
    if (outGroups.length > 0 || missingOut.length > 0) {
      h += `<div class="tbl" style="margin-bottom:8px">`;
      const outCount = outGroups.reduce((n, g) => n + g.items.length, 0);
      h += this.divider('out', 'Outgoing', 'this entity is the source', outCount);
      for (const g of outGroups) {
        h += this.edgeRow(focusType, focusHue, g, 'out');
      }
      for (const issue of missingOut) {
        h += this.ghostRow(focusType, focusHue, issue.pathLabel, issue.severity,
          issue.expectedRangeLabel ?? 'entity', issue.isObject, issue.message, issue.path, issue.expectedRange);
      }
      h += `</div>`;
    }

    // incoming
    if (inGroups.length > 0) {
      h += `<div class="tbl" style="margin-bottom:8px">`;
      const inCount = inGroups.reduce((n, g) => n + g.items.length, 0);
      h += this.divider('in', 'Incoming', 'this entity is the target', inCount);
      for (const g of inGroups) {
        h += this.edgeRow(focusType, focusHue, g, 'in');
      }
      h += `</div>`;
    }

    // add relationship button (local only)
    if (!readonly) {
      h += `<div style="padding:10px 14px 14px"><button class="add-rel-btn" data-subj="${esc(iri)}"><span class="codicon codicon-add"></span>Add relationship</button></div>`;
    }

    return this.wrap(h);
  }

  // ==================== NAMESPACE VIEW ====================

  private renderNamespace(): string {
    if (!this.selectedIri || !this.store.isLoaded) {
      return this.wrap('<p class="empty">Select an ontology</p>');
    }

    const ns = this.selectedIri;
    const label = this.selectedNsLabel ?? this.store.localName(ns);

    // ontology metadata
    const commentRows = this.store.query(`SELECT ?c WHERE { <${ns}> rdfs:comment ?c } LIMIT 1`);
    const comment = commentRows[0]?.get('c')?.value;

    const importsRows = this.store.query(`SELECT ?imp WHERE { <${ns}> owl:imports ?imp }`);
    const imports = importsRows.map(r => this.store.compact(r.get('imp')!.value));

    // counts scoped to this namespace
    const classRows = this.store.query(`SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ?c a owl:Class . FILTER(STRSTARTS(STR(?c), "${ns}")) }`);
    const classCount = parseInt(classRows[0]?.get('n')?.value ?? '0', 10);

    const propRows = this.store.query(`SELECT (COUNT(DISTINCT ?p) AS ?n) WHERE { ?p a ?t . FILTER(?t IN (owl:ObjectProperty, owl:DatatypeProperty)) FILTER(STRSTARTS(STR(?p), "${ns}")) }`);
    const propCount = parseInt(propRows[0]?.get('n')?.value ?? '0', 10);

    const instRows = this.store.query(`SELECT (COUNT(DISTINCT ?i) AS ?n) WHERE { ?i a ?c . ?c a owl:Class . FILTER(STRSTARTS(STR(?c), "${ns}")) FILTER(isIRI(?i)) }`);
    const instCount = parseInt(instRows[0]?.get('n')?.value ?? '0', 10);

    let h = '';

    h += `<div class="crumb-strip">`;
    h += `<span class="crumb-kind">Ontology</span>`;
    h += `<span class="crumb-pill" style="--h:212"><span class="crumb-dot" style="--h:212"></span><span class="crumb-name" style="--h:212">${esc(label)}</span></span>`;
    h += `<span style="margin-left:auto" class="crumb-edit codicon codicon-edit" data-action="editOntology" data-ns="${esc(ns)}" data-label="${esc(label)}" data-comment="${esc(comment ?? '')}" title="Edit ontology"></span>`;
    h += `</div>`;
    if (comment) {
      h += `<div style="padding:8px 14px 0; font-size:12.5px; color:var(--fg-muted); line-height:1.55">${esc(comment)}</div>`;
    }

    // stats
    h += `<div class="ns-stats">`;
    h += this.statBox('Classes', classCount, 'symbol-class');
    h += this.statBox('Properties', propCount, 'symbol-property');
    h += this.statBox('Instances', instCount, 'symbol-field');
    h += `</div>`;

    // imports (only show if there are any)
    if (importsRows.length > 0) {
      h += `<div style="padding:14px 14px 0">`;
      h += `<div class="ns-section-title">IMPORTS</div>`;
      for (const r of importsRows) {
        const impIri = r.get('imp')!.value;
        const impLabel = this.store.getLabel(impIri) ?? this.store.compact(impIri);
        const impPrefix = this.store.compact(impIri);
        h += `<div class="used-row" style="margin-left:0;margin-right:0"><span class="codicon codicon-symbol-namespace" style="font-size:15px;color:var(--fg-muted)"></span><span style="font-size:13px;color:var(--fg);flex:1">${esc(impLabel)}</span><span style="font-size:11px;color:var(--fg-muted);font-weight:700">${esc(impPrefix)}</span><span class="node-x" data-action="removeImport" data-ns="${esc(ns)}" data-import="${esc(impIri)}" title="Remove import" style="color:var(--fg-muted)"><span class="codicon codicon-close"></span></span></div>`;
      }
      h += `</div>`;
    }

    // action buttons
    h += `<div style="display:flex;gap:8px;padding:18px 14px">`;
    h += `<button class="form-btn form-btn-primary" data-action="newClass" data-ns="${esc(ns)}"><span class="codicon codicon-add"></span>New Class</button>`;
    h += `<button class="form-btn form-btn-secondary" data-action="addImport" data-ns="${esc(ns)}"><span class="codicon codicon-symbol-namespace"></span>Add Import</button>`;
    h += `</div>`;

    return this.wrap(h);
  }

  private statBox(label: string, count: number, icon: string): string {
    return `<div class="stat-box"><div class="stat-count">${count}</div><div class="stat-label">${label}</div></div>`;
  }

  // ==================== SCHEMA VIEW ====================

  private renderSchema(): string {
    if (!this.selectedIri || !this.store.isLoaded) {
      return this.wrap('<p class="empty">Select a type to see its schema</p>');
    }

    const classIri = this.selectedIri;
    const classLabel = this.store.getLabel(classIri) ?? this.store.localName(classIri);
    const classHue = hueFor(classLabel);
    const comment = this.store.getComment(classIri);

    // cheap: count direct instances
    const countRows = this.store.query(`SELECT (COUNT(DISTINCT ?i) AS ?n) WHERE { ?i a <${classIri}> . FILTER(isIRI(?i)) }`);
    const instCount = parseInt(countRows[0]?.get('n')?.value ?? '0', 10);

    // Walk the full superclass chain for inherited properties
    const superclassIris: string[] = [];
    const visited = new Set<string>([classIri]);
    const queue = [classIri];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const parents = this.store.query(`SELECT ?parent WHERE { <${current}> rdfs:subClassOf ?parent . ?parent a owl:Class . FILTER(?parent != <${current}>) }`);
      for (const r of parents) {
        const p = r.get('parent')!.value;
        if (!visited.has(p)) {
          visited.add(p);
          superclassIris.push(p);
          queue.push(p);
        }
      }
    }
    // Direct superclass for display
    const directSuperRows = this.store.query(`SELECT ?parent ?label WHERE { <${classIri}> rdfs:subClassOf ?parent . ?parent a owl:Class . FILTER(?parent != <${classIri}>) OPTIONAL { ?parent rdfs:label ?label } } LIMIT 1`);
    const superclass = directSuperRows[0] ? (directSuperRows[0].get('label')?.value ?? this.store.localName(directSuperRows[0].get('parent')!.value)) : undefined;

    // properties with domain = this class (direct)
    const propRows = this.store.query(`
      SELECT DISTINCT ?p ?pLabel ?range ?rangeLabel ?propType WHERE {
        ?p rdfs:domain <${classIri}> .
        ?p a ?propType .
        FILTER(?propType IN (owl:ObjectProperty, owl:DatatypeProperty))
        OPTIONAL { ?p rdfs:label ?pLabel }
        OPTIONAL { ?p rdfs:range ?range .
                   OPTIONAL { ?range rdfs:label ?rangeLabel } }
      } ORDER BY ?pLabel
    `);

    // inherited properties from superclasses
    const directPropIris = new Set(propRows.map(r => r.get('p')!.value));
    const inheritedRows: typeof propRows = [];
    for (const superIri of superclassIris) {
      const superProps = this.store.query(`
        SELECT DISTINCT ?p ?pLabel ?range ?rangeLabel ?propType WHERE {
          ?p rdfs:domain <${superIri}> .
          ?p a ?propType .
          FILTER(?propType IN (owl:ObjectProperty, owl:DatatypeProperty))
          OPTIONAL { ?p rdfs:label ?pLabel }
          OPTIONAL { ?p rdfs:range ?range .
                     OPTIONAL { ?range rdfs:label ?rangeLabel } }
        } ORDER BY ?pLabel
      `);
      for (const r of superProps) {
        const pIri = r.get('p')!.value;
        if (!directPropIris.has(pIri)) {
          directPropIris.add(pIri);
          inheritedRows.push(r);
        }
      }
    }

    // cheap: properties actually used by instances of this class
    const usedRows = this.store.query(`
      SELECT DISTINCT ?p ?pLabel WHERE {
        ?inst a <${classIri}> .
        ?inst ?p ?o .
        FILTER(?p != rdf:type && ?p != rdfs:subClassOf)
        OPTIONAL { ?p rdfs:label ?pLabel }
      } LIMIT 50
    `);
    const declaredProps = new Set(propRows.map(r => r.get('p')!.value));
    const usedOnlyProps = usedRows.filter(r => !declaredProps.has(r.get('p')!.value));

    const readonly = this.isRemote;
    let h = '';

    // breadcrumb
    h += `<div class="crumb-strip">`;
    h += `<span class="crumb-kind">${readonly ? 'REMOTE CLASS' : 'CLASS'}</span>`;
    h += `<span class="crumb-pill" style="--h:${classHue}"><span class="crumb-dot" style="--h:${classHue}"></span><span class="crumb-name" style="--h:${classHue}">${esc(classLabel)}</span></span>`;
    if (superclass) {
      const superIri = directSuperRows[0]!.get('parent')!.value;
      const superHue = hueFor(superclass);
      h += `<span class="codicon codicon-chevron-right" style="font-size:13px;color:var(--fg-muted)"></span>`;
      h += `<a class="crumb-pill" style="--h:${superHue};cursor:pointer" data-iri="${esc(superIri)}" title="Superclass"><span class="crumb-dot" style="--h:${superHue}"></span><span class="crumb-name" style="--h:${superHue}">${esc(superclass)}</span></a>`;
    } else {
      h += `<span class="codicon codicon-chevron-right" style="font-size:13px;color:var(--fg-muted)"></span>`;
      h += `<span class="crumb-parent">owl:Class</span>`;
    }
    if (!readonly) {
      h += `<span style="margin-left:auto" class="crumb-edit codicon codicon-edit" data-action="editClass" data-iri="${esc(classIri)}" data-label="${esc(classLabel)}" data-comment="${esc(comment ?? '')}" title="Edit class"></span>`;
    }
    h += `</div>`;

    // class info
    if (superclass) {
      h += `<div style="padding:6px 14px 2px;font-size:11px;color:var(--fg-muted)">Subclass of <strong>${esc(superclass)}</strong></div>`;
    }
    if (comment) {
      h += `<div style="padding:${superclass ? '2px' : '8px'} 14px 4px 14px;font-size:12.5px;color:var(--fg-muted);line-height:1.55">${esc(comment)}</div>`;
    }

    // column headers
    h += `<div class="col-headers"><div class="c-src">Class</div><div class="c-rel">Property</div><div class="c-tgt">Range</div></div>`;

    const dataProps = propRows.filter(r => r.get('propType')!.value.includes('DatatypeProperty'));
    const objProps = propRows.filter(r => r.get('propType')!.value.includes('ObjectProperty'));

    // datatype properties — card with header inside
    if (dataProps.length > 0) {
      h += `<div class="tbl" style="margin-bottom:8px">`;
      h += this.divider('param', 'Datatype properties', '', dataProps.length);
      for (const p of dataProps) {
        h += this.schemaPropertyRow(classLabel, classHue, p, classIri);
      }
      h += `</div>`;
    }

    // object properties — card with header inside
    if (objProps.length > 0) {
      h += `<div class="tbl" style="margin-bottom:8px">`;
      h += this.divider('out', 'Object properties', '', objProps.length);
      for (const p of objProps) {
        h += this.schemaPropertyRow(classLabel, classHue, p, classIri);
      }
      h += `</div>`;
    }

    // inherited properties (from superclasses)
    if (inheritedRows.length > 0) {
      const inhData = inheritedRows.filter(r => r.get('propType')!.value.includes('DatatypeProperty'));
      const inhObj = inheritedRows.filter(r => r.get('propType')!.value.includes('ObjectProperty'));
      const ancestorNames = superclassIris.slice(0, 3).map(s => this.store.getLabel(s) ?? this.store.localName(s)).join(', ');
      if (inhData.length > 0) {
        h += `<div class="tbl" style="margin-bottom:8px">`;
        h += this.divider('param', `Inherited datatype properties`, `from ${ancestorNames}`, inhData.length);
        for (const p of inhData) { h += this.schemaPropertyRow(classLabel, classHue, p, classIri); }
        h += `</div>`;
      }
      if (inhObj.length > 0) {
        h += `<div class="tbl" style="margin-bottom:8px">`;
        h += this.divider('out', `Inherited object properties`, `from ${ancestorNames}`, inhObj.length);
        for (const p of inhObj) { h += this.schemaPropertyRow(classLabel, classHue, p, classIri); }
        h += `</div>`;
      }
    }

    // action buttons (local only)
    if (!readonly) {
      h += `<div style="padding:10px 14px 14px; display:flex; gap:8px">`;
      h += `<button class="add-rel-btn" data-action="newProp" data-class-iri="${esc(classIri)}" data-class-name="${esc(classLabel)}"><span class="codicon codicon-add"></span>Add property</button>`;
      h += `<button class="add-rel-btn" data-action="newInst" data-class-iri="${esc(classIri)}" data-class-name="${esc(classLabel)}"><span class="codicon codicon-add"></span>New instance</button>`;
      h += `</div>`;
    }

    // used but not declared (exclude inherited)
    const allDeclaredIris = new Set([...propRows, ...inheritedRows].map(r => r.get('p')!.value));
    const filteredUsed = usedOnlyProps.filter(r => !allDeclaredIris.has(r.get('p')!.value));
    if (filteredUsed.length > 0) {
      h += `<div style="padding:12px 14px 6px"><div class="ns-section-title">Also used by instances (not in domain)</div></div>`;
      for (const r of filteredUsed) {
        const pLabel = r.get('pLabel')?.value ?? this.store.localName(r.get('p')!.value);
        h += `<div class="used-row"><span style="font-size:13px;font-weight:600;color:var(--fg)">${esc(pLabel)}</span><span class="mono" style="color:var(--fg-muted)">${esc(this.store.compact(r.get('p')!.value))}</span></div>`;
      }
    }

    if (propRows.length === 0 && inheritedRows.length === 0 && filteredUsed.length === 0) {
      h += `<p class="empty">No properties defined for this class.</p>`;
    }

    return this.wrap(h);
  }

  // ==================== ROW BUILDERS ====================

  private paramRow(focusType: string, focusHue: number, f: Field): string {
    let h = `<div class="row param-hover">`;
    h += `<div class="c-src cell">${this.thisBox(focusType, focusHue)}</div>`;
    h += `<div class="c-rel cell">${this.relCell(f.name, 'param')}</div>`;
    h += `<div class="c-tgt cell">${this.valueBox(f, f.predIri)}</div>`;
    h += `</div>`;
    return h;
  }

  private edgeRow(focusType: string, focusHue: number, g: GroupedEdge, dir: 'out' | 'in'): string {
    const cls = dir === 'out' ? 'out-hover' : 'in-hover';
    let h = `<div class="row ${cls}">`;
    if (dir === 'out') {
      h += `<div class="c-src cell">${this.thisBox(focusType, focusHue)}</div>`;
      h += `<div class="c-rel cell">${this.relCell(g.relationLabel, dir)}</div>`;
      h += `<div class="c-tgt cell stack">${g.items.map(i => this.entityBox(i.label, i.type, i.iri, g.relation, 'out')).join('')}</div>`;
    } else {
      h += `<div class="c-src cell stack">${g.items.map(i => this.entityBox(i.label, i.type, i.iri, g.relation, 'in')).join('')}</div>`;
      h += `<div class="c-rel cell">${this.relCell(g.relationLabel, dir)}</div>`;
      h += `<div class="c-tgt cell">${this.thisBox(focusType, focusHue)}</div>`;
    }
    h += `</div>`;
    return h;
  }

  private ghostRow(focusType: string, focusHue: number, propLabel: string,
    severity: 'violation' | 'warning' | 'optional', rangeLabel: string,
    isObject: boolean, message: string, propIri?: string, rangeIri?: string): string {

    const sevClass = severity === 'violation' ? 'sev-viol' : severity === 'warning' ? 'sev-warn' : 'sev-opt';
    const sevLabel = severity === 'violation' ? 'Required' : severity === 'warning' ? 'Recommended' : 'Optional';
    const addAttr = propIri && this.selectedIri
      ? ` data-add-subj="${esc(this.selectedIri)}" data-add-pred="${esc(propIri)}" data-add-range="${esc(rangeIri ?? '')}" data-add-isobj="${isObject}"`
      : '';

    let h = `<div class="row ghost-row ${sevClass}-row">`;
    h += `<div class="c-src cell">${this.thisBox(focusType, focusHue)}</div>`;
    h += `<div class="c-rel cell"><span class="rel-name">${esc(propLabel)}</span>`;
    h += `<span class="connector"><span class="conn-line-dashed ${sevClass}-line"></span><span class="conn-arrow ${sevClass}-arrow">&#9656;</span></span>`;
    h += `<span class="sev-pill ${sevClass}-pill">${sevLabel}</span></div>`;
    h += `<div class="c-tgt cell"><div class="ghost-target ${sevClass}-ghost add-btn"${addAttr}>`;
    h += `<span class="gt-label">Expected</span>`;
    h += `<span class="gt-range">${esc(rangeLabel)}</span>`;
    if (severity !== 'optional') {
      h += `<span class="gt-add ${sevClass}-add">&#65291; Add value</span>`;
    }
    h += `</div></div>`;
    h += `</div>`;
    return h;
  }

  private schemaPropertyRow(classLabel: string, classHue: number, row: Map<string, { value: string; termType: string }>, classIri?: string): string {
    const pIri = row.get('p')!.value;
    const pLabel = row.get('pLabel')?.value ?? this.store.localName(pIri);
    const rangeVal = row.get('range')?.value;
    const rangeLabel = row.get('rangeLabel')?.value ?? (rangeVal ? this.store.localName(rangeVal) : 'any');
    const isObject = row.get('propType')!.value.includes('ObjectProperty');
    const rangeHue = isObject && rangeVal ? hueFor(this.store.localName(rangeVal)) : 0;

    // determine severity from SHACL (lightweight — check if this property has a shape constraint)
    let severity = 'optional';
    if (classIri) {
      try {
        const shaclRows = this.store.query(`
          SELECT ?minCount ?severity WHERE {
            ?shape <http://www.w3.org/ns/shacl#targetClass> <${classIri}> .
            ?shape <http://www.w3.org/ns/shacl#property> ?pc .
            ?pc <http://www.w3.org/ns/shacl#path> <${pIri}> .
            OPTIONAL { ?pc <http://www.w3.org/ns/shacl#minCount> ?minCount }
            OPTIONAL { ?pc <http://www.w3.org/ns/shacl#severity> ?severity }
          } LIMIT 1
        `);
        if (shaclRows.length > 0) {
          const min = parseInt(shaclRows[0].get('minCount')?.value ?? '0', 10);
          const sev = shaclRows[0].get('severity')?.value;
          if (min > 0) {
            severity = sev?.endsWith('Warning') ? 'recommended' : 'required';
          }
        }
      } catch { /* */ }
    }

    const pillClass = severity === 'required' ? 'pill-required' : severity === 'recommended' ? 'pill-recommended' : 'pill-optional';

    let h = `<div class="schema-row">`;
    h += `<div class="c-src cell"><span class="class-box compact" style="--h:${classHue}"><span class="cb-label"><span class="cb-dot" style="--h:${classHue}"></span><span class="cb-type" style="--h:${classHue}">Class</span></span><span class="cb-name" style="--h:${classHue}">${esc(classLabel)}</span></span></div>`;
    h += `<div class="c-rel cell"><span class="rel-name" style="font-weight:600;color:var(--fg)">${esc(pLabel)}</span>`;
    h += `<span class="codicon codicon-arrow-small-right rel-arrow"></span>`;
    h += `<span class="sev-pill-schema ${pillClass}">${severity.toUpperCase()}</span></div>`;
    if (isObject && !rangeVal) {
      h += `<div class="c-tgt cell"><span class="range-box" style="border-color:var(--err);"><span class="rb-label"><span class="rb-dot" style="background:var(--err)"></span><span class="rb-type" style="color:var(--err)">Expected</span></span><span class="rb-name" style="color:var(--err)">${esc(rangeLabel)}</span></span></div>`;
    } else if (isObject) {
      h += `<div class="c-tgt cell"><span class="range-box" style="--h:${rangeHue}"><span class="rb-label"><span class="rb-dot" style="--h:${rangeHue}"></span><span class="rb-type" style="--h:${rangeHue}">Expected</span></span><span class="rb-name" style="--h:${rangeHue}">${esc(rangeLabel)}</span></span></div>`;
    } else {
      h += `<div class="c-tgt cell"><span class="range-box-dt"><span class="rbd-label">Datatype</span><span class="rbd-name">${esc(rangeLabel)}</span></span></div>`;
    }
    h += `</div>`;
    return h;
  }

  private schemaRow(classLabel: string, classHue: number, p: PropertyDef, c: ShaclConstraint | undefined): string {
    const sevLabel = c?.minCount && c.minCount > 0
      ? (c.severity === 'violation' ? 'Required' : 'Recommended')
      : 'Optional';
    const sevClass = c?.minCount && c.minCount > 0
      ? (c.severity === 'violation' ? 'sev-viol' : 'sev-warn')
      : 'sev-opt';

    const rangeLabel = p.rangeLabel ?? 'any';
    const rangeHue = p.isObject && p.range ? hueFor(this.store.localName(p.range)) : 0;

    let h = `<div class="row param-hover">`;
    // class pivot
    h += `<div class="c-src cell"><span class="class-box compact" style="--h:${classHue}"><span class="cb-label"><span class="cb-dot" style="--h:${classHue}"></span><span class="cb-type" style="--h:${classHue}">Class</span></span><span class="cb-name" style="--h:${classHue}">${esc(classLabel)}</span></span></div>`;
    // property name + constraint pill
    h += `<div class="c-rel cell"><span class="rel-name" style="font-weight:600;color:var(--fg)">${esc(p.label)}</span>`;
    h += `<span class="connector"><span class="conn-line-dashed sev-opt-line"></span><span class="conn-arrow sev-opt-arrow">&#9656;</span></span>`;
    h += `<span class="sev-pill ${sevClass}-pill">${sevLabel}</span></div>`;
    // range
    if (p.isObject) {
      h += `<div class="c-tgt cell"><span class="range-box" style="--h:${rangeHue}"><span class="rb-label"><span class="rb-dot" style="--h:${rangeHue}"></span><span class="rb-type" style="--h:${rangeHue}">Expected</span></span><span class="rb-name" style="--h:${rangeHue}">${esc(rangeLabel)}</span></span></div>`;
    } else {
      h += `<div class="c-tgt cell"><span class="range-box-dt"><span class="rbd-label">Datatype</span><span class="rbd-name">${esc(rangeLabel)}</span></span></div>`;
    }
    h += `</div>`;
    return h;
  }

  // ==================== NODE BOXES ====================

  private thisBox(type: string, hue: number): string {
    return `<div class="node-box full pivot" style="--h:${hue}"><div class="node-label"><span class="node-dot" style="--h:${hue}"></span><span class="node-type" style="--h:${hue}">${esc(type)}</span></div><span class="node-name" style="--h:${hue}; font-weight:600;">this</span></div>`;
  }

  private entityBox(label: string, type: string, iri: string, predIri?: string, dir: 'out' | 'in' = 'out'): string {
    const h = hueFor(type);
    const decoded = this.decodeDisplay(label);
    const truncated = decoded.length > 30 ? decoded.slice(0, 28) + '…' : decoded;
    const canEdit = !this.isRemote && predIri && this.selectedIri;
    const delAttr = canEdit
      ? ` data-del-subj="${esc(this.selectedIri!)}" data-del-pred="${esc(predIri!)}" data-del-obj="${esc(iri)}" data-del-label="${esc(label)}"`
      : '';
    const editAttr = canEdit
      ? ` data-edit-subj="${esc(this.selectedIri!)}" data-edit-pred="${esc(predIri!)}" data-edit-obj="${esc(iri)}" data-edit-label="${esc(label)}" data-edit-dir="${dir}"`
      : '';
    return `<a class="node-box full clickable" data-iri="${esc(iri)}" title="${esc(label)}  ·  ${esc(type)}" style="--h:${h}"><div class="node-label"><span class="node-dot" style="--h:${h}"></span><span class="node-type" style="--h:${h}">${esc(type)}</span><span class="node-actions"><span class="node-edit edit-rel-btn"${editAttr} style="--h:${h}" title="Edit"><span class="codicon codicon-edit"></span></span><span class="node-x del-btn"${delAttr} style="--h:${h}" title="Remove"><span class="codicon codicon-close"></span></span></span></div><span class="node-name" style="--h:${h}">${esc(truncated)}</span></a>`;
  }

  private entityChipInline(label: string, type: string, iri: string): string {
    const h = hueFor(type);
    const truncated = label.length > 28 ? label.slice(0, 26) + '…' : label;
    return `<a class="echip" data-iri="${esc(iri)}" title="${esc(label)}  ·  ${esc(type)}" style="--h:${h}"><span class="edot" style="--h:${h}"></span><span class="ename" style="--h:${h}">${esc(truncated)}</span></a>`;
  }

  private decodeDisplay(s: string): string {
    try { return decodeURIComponent(s); } catch { return s; }
  }

  private valueBox(f: Field, predIri?: string): string {
    const display = this.decodeDisplay(f.value);
    let content = '';
    switch (f.valueType) {
      case 'boolean':
        content = f.value === 'true' ? `<span class="vb-true">true</span>` : `<span class="vb-false">false</span>`;
        break;
      case 'enum':
        content = `<span class="vb-enum"><span class="vb-enum-dot"></span>${esc(display)}</span>`;
        break;
      case 'number': case 'date':
        content = `<span class="vb-mono">${esc(display)}</span>`;
        break;
      default:
        content = `<span class="vb-text">${esc(display)}</span>`;
    }
    const delAttr = predIri && this.selectedIri
      ? ` data-del-subj="${esc(this.selectedIri)}" data-del-pred="${esc(predIri)}" data-del-obj="${esc(f.value)}"`
      : '';
    const editAttr = predIri && this.selectedIri
      ? ` data-edit-subj="${esc(this.selectedIri)}" data-edit-pred="${esc(predIri)}" data-edit-old="${esc(f.value)}"`
      : '';
    return `<div class="val-box edit-target"${editAttr}><div class="node-label"><span class="vb-type">${esc(f.valueType.toUpperCase())}</span><span class="val-x del-btn"${delAttr} title="Remove"><span class="codicon codicon-close"></span></span></div>${content}</div>`;
  }

  // ==================== HELPERS ====================

  private divider(kind: 'param' | 'out' | 'in', label: string, hint: string, count?: number): string {
    const countHtml = count !== undefined ? `<span style="margin-left:auto;font-size:10px;color:var(--fg-muted)">${count}</span>` : '';
    return `<div class="divider ${kind}-div"><span class="div-bar ${kind}-bar"></span><span class="div-label ${kind}-label">${label}</span>${hint ? `<span class="div-hint">${hint}</span>` : ''}${countHtml}</div>`;
  }

  private relCell(label: string, kind: 'param' | 'out' | 'in'): string {
    return `<span class="rel-name">${esc(label)}</span><span class="codicon codicon-arrow-small-right rel-arrow"></span>`;
  }

  private getFields(iri: string): Field[] {
    const outgoing = this.store.getOutgoing(iri);
    const fields: Field[] = [];
    for (const prop of outgoing) {
      for (const val of prop.values) {
        if (!val.isIri) {
          fields.push({ name: prop.predicateLabel, predIri: prop.predicate, valueType: this.inferValueType(val.value), value: val.value });
        }
      }
    }
    return fields;
  }

  private inferValueType(value: string): string {
    if (value === 'true' || value === 'false') { return 'boolean'; }
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) { return 'date'; }
    if (/^-?\d[\d,.]*$/.test(value)) { return 'number'; }
    return 'string';
  }

  private buildGroups(iri: string, direction: 'out' | 'in'): GroupedEdge[] {
    const props = direction === 'out' ? this.store.getOutgoing(iri) : this.store.getIncoming(iri);
    const groups: GroupedEdge[] = [];
    for (const prop of props) {
      const items: GroupedEdge['items'] = [];
      // Get the declared range/domain as fallback type
      const rangeProp = direction === 'out' ? 'rdfs:range' : 'rdfs:domain';
      const rangeRows = this.store.query(`SELECT ?r WHERE { <${prop.predicate}> ${rangeProp} ?r } LIMIT 3`);
      const genericNames = new Set(['Resource', 'Thing', 'Class', 'Property', 'Literal']);
      const rangeFallback = rangeRows
        .map(r => this.store.localName(r.get('r')!.value))
        .find(n => !genericNames.has(n)) ?? 'Resource';

      for (const val of prop.values) {
        if (val.isIri) {
          const isNamedIri = val.value.includes(':') || val.value.includes('/');
          const tt = isNamedIri ? this.store.getTypes(val.value) : [];
          items.push({ iri: val.value, label: val.label, type: tt[0] ?? rangeFallback });
        }
      }
      if (items.length > 0) { groups.push({ relation: prop.predicate, relationLabel: prop.predicateLabel, items }); }
    }
    return groups;
  }

  private getClassIri(entityIri: string): string | undefined {
    const rows = this.store.query(`SELECT ?t WHERE { <${entityIri}> a ?t . ?t a owl:Class . } LIMIT 1`);
    return rows[0]?.get('t')?.value;
  }

  private getMissingParams(iri: string, vr: ValidationResult) {
    return [...vr.violations, ...vr.warnings].filter(i => i.kind === 'missing' && !i.isObject);
  }

  private getMissingOutgoing(iri: string, vr: ValidationResult) {
    return [...vr.violations, ...vr.warnings].filter(i => (i.kind === 'missing' && i.isObject) || i.kind === 'or-group');
  }

  private getSchemaHints(iri: string, fields: Field[], outGroups: GroupedEdge[], vr: ValidationResult) {
    const classIri = this.getClassIri(iri);
    if (!classIri) { return []; }

    const props = this.schema.getPropertiesForClass(classIri);
    const existingPredicates = new Set<string>();
    for (const f of fields) { /* fields use labels, need IRIs — skip for now */ }
    for (const g of outGroups) { existingPredicates.add(g.relation); }
    const issuePaths = new Set([...vr.violations, ...vr.warnings].map(i => i.path));

    return props.filter(p =>
      !existingPredicates.has(p.iri) && !issuePaths.has(p.iri) && p.domain !== undefined
    );
  }

  // ==================== WRAP ====================

  private getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let nonce = '';
    for (let i = 0; i < 32; i++) { nonce += chars.charAt(Math.floor(Math.random() * chars.length)); }
    return nonce;
  }

  private getCodiconCssUri(): string {
    if (!this.view || !this.extensionUri) { return ''; }
    return this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    ).toString();
  }

  private wrap(body: string): string {
    const nonce = this.getNonce();
    const cspSource = this.view?.webview.cspSource ?? '';
    const codiconCss = this.getCodiconCssUri();

    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${codiconCss}">
<style nonce="${nonce}">
:root {
  --accent: var(--vscode-textLink-foreground, #0a60c4);
  --accent-in: #7a4dd6;
  --accent-param: #6b7280;
  --fg: var(--vscode-foreground, #3b3b3b);
  --fg-muted: var(--vscode-descriptionForeground, #9a9a9a);
  --bg: var(--vscode-sideBar-background, var(--vscode-editor-background, #fff));
  --bg-value: var(--vscode-textCodeBlock-background, #f3f3f5);
  --border: var(--vscode-panel-border, var(--vscode-widget-border, #e6e6e6));
  --border-strong: var(--vscode-input-border, #cecece);
  --border-inner: var(--vscode-sideBarSectionHeader-border, #efefef);
  --bg-section: var(--vscode-sideBarSectionHeader-background, rgba(0,0,0,.04));
  --list-hover: var(--vscode-list-hoverBackground, #e8e8e8);
  --input-bg: var(--vscode-input-background, #fff);
  --focus-border: var(--vscode-focusBorder, #005fb8);
  --link: var(--vscode-textLink-foreground, #005fb8);
  --err: var(--vscode-errorForeground, #cd3131);
  --err-bg: var(--vscode-inputValidation-errorBackground, #fbebec);
  --err-border: var(--vscode-inputValidation-errorBorder, #eeaeae);
  --warn: var(--vscode-editorWarning-foreground, #bb8009);
  --warn-bg: var(--vscode-inputValidation-warningBackground, #fbf3e1);
  --warn-border: var(--vscode-inputValidation-warningBorder, #e8d199);
  --ok: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #107c10));
}
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:var(--vscode-font-family); font-size:13px; color:var(--fg); background:var(--bg); }
.empty { color:var(--fg-muted); text-align:center; padding:24px 12px; font-size:12px; }
.mono { font-family:var(--vscode-editor-font-family, 'SF Mono',Monaco,Menlo,Consolas,monospace); font-size:11px; }

/* breadcrumb strip */
.crumb-strip { display:flex; align-items:center; gap:8px; padding:8px 14px 6px; border-bottom:1px solid var(--border); }
.crumb-kind { font-size:10px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--fg-muted); }
.crumb-pill { display:inline-flex; align-items:center; gap:5px; padding:2px 9px 2px 7px; border-radius:11px; text-decoration:none; cursor:pointer; border:1px solid hsl(var(--h,212) 52% 80%); background:hsl(var(--h,212) 70% 96.5%); }
.crumb-pill:hover { filter:brightness(.97); }
.crumb-dot { width:6px; height:6px; border-radius:50%; flex:0 0 auto; background:hsl(var(--h,212) 58% 42%); }
.crumb-name { font-size:12px; font-weight:600; color:hsl(var(--h,212) 55% 33%); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.crumb-parent { font-size:11px; color:var(--fg-muted); text-transform:uppercase; letter-spacing:.04em; }
.crumb-edit { font-size:14px; color:var(--fg-muted); cursor:pointer; padding:2px; border-radius:4px; }
.crumb-edit:hover { color:var(--fg); background:var(--list-hover); }
.vscode-dark .crumb-pill { background:hsl(var(--h,212) 34% 15%); border-color:hsl(var(--h,212) 36% 38%); }
.vscode-dark .crumb-dot { background:hsl(var(--h,212) 58% 62%); }
.vscode-dark .crumb-name { color:hsl(var(--h,212) 52% 72%); }

/* validation banner */
.val-banner { display:flex; align-items:center; gap:8px; padding:7px 10px; border-radius:5px; margin:10px 14px 0; border:1px solid var(--border); }
.val-fail { background:var(--err-bg); border-color:var(--err-border); }
.val-pass { background:var(--warn-bg,#e7f4ec); border-color:var(--warn-border,#bfe3cc); }
.val-title { font-size:12px; font-weight:600; }
.val-fail .val-title { color:var(--err); }
.val-pass .val-title { color:var(--ok); }
.val-pill { font-size:11px; font-weight:600; border-radius:9px; padding:1px 8px; }
.viol-pill { color:#fff; background:var(--err); }
.warn-pill { color:var(--warn); background:var(--warn-bg); border:1px solid var(--warn-border); }

/* counts + headers */
.counts { padding:10px 14px 0; font-size:12px; color:var(--fg-muted); margin-bottom:8px; }
.accent { color:var(--accent); font-weight:600; }
.col-headers { display:flex; padding:12px 14px 5px; }
.col-headers > div { font-size:9px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--fg-muted); }
.c-src, .c-tgt { flex:1 1 0; min-width:0; }
.c-rel { flex:0 0 92px; text-align:center; }
.tbl { border:1px solid var(--border); border-radius:6px; overflow:hidden; margin:0 14px 6px; background:var(--vscode-editor-background, #fff); }

/* dividers */
.divider { display:flex; align-items:center; gap:6px; padding:5px 9px; background:var(--bg-section); }
.in-div { border-top:1px solid var(--border); }
.div-bar { width:7px; height:7px; border-radius:2px; flex:0 0 auto; }
.param-bar { background:var(--accent-param); } .out-bar { background:var(--accent); } .in-bar { background:var(--accent-in); }
.div-label { font-size:10px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
.param-label { color:var(--accent-param); } .out-label { color:var(--accent); } .in-label { color:var(--accent-in); }
.div-hint { font-size:10px; color:var(--fg-muted); opacity:.7; }

/* rows */
.row { display:flex; align-items:stretch; border-top:1px solid var(--border-inner); }
.out-hover:hover { background:rgba(10,96,196,.03); }
.in-hover:hover { background:rgba(122,77,214,.03); }
.param-hover:hover { background:var(--bg-section); }
.cell { padding:7px 9px; display:flex; align-items:center; }
.cell.stack { flex-direction:column; gap:6px; justify-content:center; align-items:stretch; }
.row .c-src { flex:1 1 0; min-width:0; }
.row .c-rel { flex:0 0 92px; padding:7px 4px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:1px; }
.row .c-tgt { flex:1 1 0; min-width:0; }

/* relation cell */
.rel-name { font-size:11.5px; font-weight:500; color:var(--fg); text-align:center; line-height:1.15; word-break:break-word; }
.rel-arrow { font-size:15px; color:var(--fg-muted); opacity:.5; }
.connector { display:flex; align-items:center; width:48px; }
.conn-line { flex:1; height:1.5px; background:var(--border-inner); }
.conn-line-dashed { flex:1; height:0; border-top:1.5px dashed var(--border-inner); }
.conn-arrow { font-size:11px; line-height:1; margin-left:-2px; }
.param-arrow { color:var(--accent-param); } .out-arrow { color:var(--accent); } .in-arrow { color:var(--accent-in); }

/* severity */
.sev-pill { font-size:8px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; border-radius:4px; padding:1px 5px; }
.sev-viol-pill { color:#fff; background:#c0392b; }
.sev-warn-pill { color:#9a6700; background:#f4e6c2; }
.sev-opt-pill { color:#6b7280; background:#eef0f2; }
.sev-viol-line { border-color:#e09a95; } .sev-viol-arrow { color:#c0392b; }
.sev-warn-line { border-color:#d9bd73; } .sev-warn-arrow { color:#9a6700; }
.sev-opt-line { border-color:#cdced3; } .sev-opt-arrow { color:#9a9a9a; }
.sev-viol-row { background:#fdf6f5; } .sev-warn-row { background:#fdfaf0; } .sev-opt-row { }
.sev-viol-row .c-rel { border-color:#f0d6d3; }
.sev-warn-row .c-rel { border-color:#ecd9a8; }

/* ghost target box */
.ghost-target { display:flex; flex-direction:column; gap:3px; width:100%; padding:4px 8px 5px; border-radius:6px; cursor:pointer; }
.sev-viol-ghost { background:#fdeceb; border:1.5px dashed #e09a95; }
.sev-warn-ghost { background:#fbf4e3; border:1.5px dashed #d9bd73; }
.sev-opt-ghost { background:#f6f6f8; border:1.5px dashed #cdced3; }
.sev-viol-ghost:hover { background:#fbe1df; }
.sev-warn-ghost:hover { background:#f8ecd0; }
.gt-label { font-size:8px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }
.sev-viol-ghost .gt-label { color:#b06a66; }
.sev-warn-ghost .gt-label { color:#9a6700; }
.sev-opt-ghost .gt-label { color:#8a8a92; }
.gt-range { font-size:12px; font-weight:600; }
.sev-viol-ghost .gt-range { color:#a5302a; }
.sev-warn-ghost .gt-range { color:#7a5600; }
.sev-opt-ghost .gt-range { color:#5a5a62; }
.gt-add { display:inline-flex; align-items:center; gap:4px; font-size:11px; font-weight:600; }
.sev-viol-add { color:#c0392b; }
.sev-warn-add { color:#9a6700; }

/* hints disclosure */
.hints-toggle { display:flex; align-items:center; gap:6px; padding:7px 10px; background:var(--bg-section); border-top:1px solid var(--border); cursor:pointer; font-size:11px; font-weight:500; color:var(--fg-muted); }
.hints-toggle:hover { background:var(--vscode-list-hoverBackground, #f0f0f0); }
.ht-arrow { color:var(--fg-muted); font-size:9px; }
.hints-body { }
.hidden { display:none; }

/* node box */
.node-box { display:flex; flex-direction:column; gap:1px; padding:6px 7px; min-height:38px; justify-content:center; border-radius:4px; background:hsl(var(--h,212) 70% 96.5%); border:1px solid hsl(var(--h,212) 52% 80%); }
.node-box.full { width:100%; }
.node-box.pivot { max-height:42px; align-self:center; }
.node-label { display:flex; align-items:center; gap:5px; min-width:0; }
.node-dot { width:6px; height:6px; border-radius:50%; flex:0 0 auto; background:hsl(var(--h,212) 58% 42%); }
.node-type { font-size:9px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:hsl(var(--h,212) 55% 33%); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1; }
.node-name { font-size:13px; font-weight:500; color:hsl(var(--h,212) 55% 33%); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; line-height:1.25; }
.node-actions { margin-left:auto; display:flex; gap:3px; opacity:0; transition:opacity .15s; }
.node-box:hover .node-actions { opacity:1; }
.node-x, .node-edit { line-height:1; cursor:pointer; flex:0 0 auto; color:hsl(var(--h,212) 55% 33%); font-size:11px; }
.node-x:hover, .node-edit:hover { opacity:.7; }
.node-x .codicon, .node-edit .codicon { font-size:11px; }
a.node-box { text-decoration:none; cursor:pointer; }
a.node-box:hover { filter:brightness(.98); }
.vscode-dark .node-box { background:hsl(var(--h,212) 34% 15%); border-color:hsl(var(--h,212) 34% 36%); }
.vscode-dark .node-dot { background:hsl(var(--h,212) 58% 62%); }
.vscode-dark .node-type, .vscode-dark .node-name, .vscode-dark .node-x, .vscode-dark .node-edit { color:hsl(var(--h,212) 52% 72%); }

/* class box (schema view — dashed) */
.class-box { display:flex; flex-direction:column; gap:1px; padding:6px 7px; min-height:38px; justify-content:center; border-radius:4px; background:transparent; border:1.5px dashed hsl(var(--h,212) 58% 42%); width:100%; }
.class-box.compact { }
.cb-label { display:flex; align-items:center; gap:5px; }
.cb-dot { width:6px; height:6px; border-radius:50%; background:hsl(var(--h,212) 58% 42%); }
.cb-type { font-size:9px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:hsl(var(--h,212) 55% 33%); }
.cb-name { font-size:13px; font-weight:600; color:hsl(var(--h,212) 55% 33%); line-height:1.25; }
.vscode-dark .class-box { background:hsl(var(--h,212) 15% 12%); border-color:hsl(var(--h,212) 58% 62%); }
.vscode-dark .cb-dot { background:hsl(var(--h,212) 58% 62%); }
.vscode-dark .cb-type, .vscode-dark .cb-name { color:hsl(var(--h,212) 52% 72%); }

/* range box (schema view) */
.range-box { display:flex; flex-direction:column; gap:1px; padding:6px 7px; min-height:38px; justify-content:center; border-radius:4px; background:transparent; border:1.5px dashed hsl(var(--h,212) 58% 42%); width:100%; }
.rb-label { display:flex; align-items:center; gap:5px; }
.rb-dot { width:5px; height:5px; border-radius:50%; background:hsl(var(--h,212) 58% 42%); }
.rb-type { font-size:9px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:hsl(var(--h,212) 55% 33%); }
.rb-name { font-size:13px; font-weight:600; color:hsl(var(--h,212) 55% 33%); line-height:1.25; }
.vscode-dark .range-box { background:hsl(var(--h,212) 15% 12%); border-color:hsl(var(--h,212) 58% 62%); }
.vscode-dark .rb-dot { background:hsl(var(--h,212) 58% 62%); }
.vscode-dark .rb-type, .vscode-dark .rb-name { color:hsl(var(--h,212) 52% 72%); }
.range-box-dt { display:flex; flex-direction:column; gap:1px; padding:6px 7px; min-height:38px; justify-content:center; border-radius:4px; background:transparent; border:1.5px dashed var(--border-strong); width:100%; }
.rbd-label { font-size:9px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--fg-muted); }
.rbd-name { font-family:var(--vscode-editor-font-family, monospace); font-size:13px; color:var(--fg); line-height:1.25; }
.vscode-dark .range-box-dt { background:#1a1e24; border-color:#4a5568; }
.vscode-dark .rbd-label { color:#9ca3af; }

/* value box */
.val-box { display:flex; flex-direction:column; gap:1px; flex:1; min-width:0; padding:6px 7px; min-height:38px; justify-content:center; border-radius:4px; background:var(--bg-value); border:1px solid var(--border-strong); }
.vb-type { font-size:9px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--accent-param); white-space:nowrap; flex:1; min-width:0; }
.val-x { margin-left:auto; opacity:.55; line-height:1; cursor:pointer; flex:0 0 auto; font-size:11px; margin:-2px -1px -2px 0; }
.val-x:hover { opacity:1; }
.val-x .codicon { font-size:11px; }
.vb-text { font-size:13px; color:var(--fg); line-height:1.25; min-width:0; }
.vb-mono { font-family:var(--vscode-editor-font-family, monospace); font-size:12px; color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vb-true { font-size:13px; font-weight:600; color:var(--ok); }
.vb-false { font-size:13px; font-weight:600; color:var(--warn); }
.vb-enum { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:var(--fg); }
.vb-enum-dot { width:5px; height:5px; border-radius:50%; background:var(--fg-muted); flex:0 0 auto; }

/* schema */
.sel-label { font-size:10px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:var(--fg-muted); }
.schema-row { display:flex; align-items:stretch; border-top:1px solid var(--border-inner); padding:7px 9px; }
.schema-row .c-src { flex:1 1 0; min-width:0; padding:0 9px; display:flex; align-items:stretch; }
.schema-row .c-rel { flex:0 0 92px; padding:0 4px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; }
.schema-row .c-tgt { flex:1 1 0; min-width:0; padding:0 9px; display:flex; align-items:stretch; }
.sev-pill-schema { font-size:8.5px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; padding:2px 7px; border-radius:9px; cursor:pointer; white-space:nowrap; border:1px solid; }
.pill-optional { color:var(--fg-muted); border-color:var(--fg-muted); }
.pill-recommended { color:var(--warn); border-color:var(--warn); }
.pill-required { color:var(--accent); border-color:var(--accent); }
.used-row { display:flex; align-items:center; gap:12px; padding:8px 12px; margin:0 14px 5px; border:1px solid var(--border); border-radius:5px; background:var(--vscode-editor-background, #fff); }

/* SHACL summary */
.shacl-summary { margin:11px 12px 16px; padding:9px 11px; background:#fbf4e3; border:1px solid #ecd9a8; border-radius:7px; }
.ss-header { display:flex; align-items:center; gap:6px; margin-bottom:4px; font-size:10px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; color:#9a6700; }
.ss-msg { font-size:11.5px; color:#6f5a2a; line-height:1.45; margin-top:3px; }
.vscode-dark .shacl-summary { background:#1c1608; border-color:#44380a; }
.vscode-dark .ss-header { color:#fbbf24; }
.vscode-dark .ss-msg { color:#d9a441; }

/* add relationship button */
.add-rel-btn { display:flex; align-items:center; gap:6px; padding:5px 6px; border:1px dashed var(--border-strong); border-radius:5px; color:var(--fg-muted); cursor:pointer; font-size:12px; font-family:inherit; background:none; }
.add-rel-btn:hover { background:var(--list-hover); }
.add-rel-btn .codicon { font-size:14px; }

/* form modal */
#form-container { position:fixed; inset:0; z-index:50; display:flex; align-items:flex-start; justify-content:center; padding-top:40px; background:rgba(0,0,0,.25); }
.vscode-dark #form-container { background:rgba(0,0,0,.45); }
.form-card { width:calc(100% - 28px); max-width:400px; border:1px solid var(--border-strong); border-radius:7px; background:var(--vscode-editor-background, #fff); box-shadow:0 8px 30px rgba(0,0,0,.2); animation:formIn .12s ease; overflow:hidden; }
.form-header { display:flex; align-items:center; gap:8px; padding:9px 12px; border-bottom:1px solid var(--border); background:var(--bg-section); }
.form-header-title { font-size:13px; font-weight:700; color:var(--fg); flex:1; }
.form-header-sub { font-size:10px; color:var(--fg-muted); text-transform:uppercase; letter-spacing:.04em; }
.form-body { padding:13px; }
.form-field { margin-bottom:13px; }
.form-label { display:flex; align-items:baseline; gap:7px; margin-bottom:5px; }
.form-label-text { font-size:11px; font-weight:600; color:var(--fg); }
.form-label-hint { font-size:10px; color:var(--fg-muted); }
.form-input { width:100%; height:28px; padding:0 9px; border:1px solid var(--input-border, var(--border-strong)); border-radius:4px; background:var(--input-bg); color:var(--fg); font-size:13px; font-family:inherit; outline:none; }
.form-input:focus { border-color:var(--focus-border); }
.form-textarea { width:100%; padding:6px 9px; border:1px solid var(--input-border, var(--border-strong)); border-radius:4px; background:var(--input-bg); color:var(--fg); font-size:13px; font-family:inherit; outline:none; resize:vertical; }
.form-textarea:focus { border-color:var(--focus-border); }
.form-error { font-size:10px; color:var(--err); margin-top:3px; }
.form-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:2px; }
.form-btn { display:inline-flex; align-items:center; gap:5px; padding:7px 13px; font-size:12px; font-weight:600; border-radius:4px; cursor:pointer; border:none; font-family:inherit; }
.form-btn .codicon { font-size:14px; }
.form-btn-primary { background:var(--vscode-button-background, #005fb8); color:var(--vscode-button-foreground, #fff); }
.form-btn-primary:hover { opacity:.9; }
.form-btn-primary:disabled { opacity:.5; cursor:default; }
.form-btn-secondary { background:var(--vscode-button-secondaryBackground, #e5e5e5); color:var(--vscode-button-secondaryForeground, #3b3b3b); }
.form-btn-secondary:hover { opacity:.9; }
.fp-kind-btn { background:var(--vscode-button-secondaryBackground, #e5e5e5); color:var(--vscode-button-secondaryForeground, #3b3b3b); }
.fp-kind-active { background:var(--vscode-button-background, #005fb8); color:var(--vscode-button-foreground, #fff); }
@keyframes formIn { from { transform:translateY(5px) scale(.99); opacity:0; } to { transform:none; opacity:1; } }
#form-container:empty { display:none !important; }

/* inline edit */
.edit-target { cursor:pointer; }
.edit-target:hover { filter:brightness(.97); }
.inline-edit { display:flex; align-items:center; gap:4px; padding:3px; border-radius:4px; border:1px solid var(--focus-border); background:var(--input-bg); width:100%; min-height:38px; }
.inline-edit input { flex:1; min-width:0; border:none; outline:none; background:transparent; color:var(--fg); font-size:13px; padding:3px 4px; font-family:inherit; }
.inline-edit .codicon { font-size:14px; cursor:pointer; padding:2px; }
.inline-edit .codicon-check { color:var(--ok); }
.inline-edit .codicon-close { color:var(--fg-muted); }
.codicon-check::before { content:'\\eab2'; }

/* toast */
.toast { position:fixed; right:16px; bottom:12px; display:flex; align-items:center; gap:12px; padding:9px 12px; border-radius:6px; background:var(--bg); border:1px solid var(--border-strong); box-shadow:0 6px 20px rgba(0,0,0,.15); z-index:40; animation:toastIn .15s ease; font-size:12.5px; color:var(--fg); }
.toast-undo { font-size:12px; font-weight:600; color:var(--link); cursor:pointer; }
@keyframes toastIn { from { transform:translateY(10px); opacity:0; } to { transform:none; opacity:1; } }

/* namespace view */
.ns-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; padding:14px 14px 0; }
.stat-box { border:1px solid var(--border-strong); border-radius:6px; padding:15px 8px; text-align:center; background:var(--vscode-editor-background, #fff); }
.stat-count { font-size:25px; font-weight:700; color:var(--fg); line-height:1; }
.stat-label { font-size:9px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--fg-muted); margin-top:6px; }
.ns-section { padding:8px 12px 12px; }
.ns-section-title { font-size:9.5px; font-weight:700; letter-spacing:.06em; text-transform:uppercase; color:var(--fg-muted); margin-bottom:6px; }
.ns-import { font-family:'SF Mono',Monaco,Menlo,Consolas,monospace; font-size:11px; color:var(--fg); padding:3px 0; }
</style></head>
<body>
<div id="form-container"></div>
${body}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
let toastTimer = null;

function showToast(msg, hasUndo) {
  let existing = document.getElementById('kg-toast');
  if (existing) existing.remove();
  const t = document.createElement('div');
  t.id = 'kg-toast';
  t.className = 'toast';
  t.innerHTML = msg + (hasUndo ? ' <span class="toast-undo" id="toast-undo">Undo</span>' : '');
  document.body.appendChild(t);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { const el = document.getElementById('kg-toast'); if (el) el.remove(); }, 5000);
}

function startEdit(box) {
  const subj = box.dataset.editSubj;
  const pred = box.dataset.editPred;
  const oldVal = box.dataset.editOld;
  if (!subj || !pred) return;
  const edit = document.createElement('div');
  edit.className = 'inline-edit';
  edit.innerHTML = '<input value="' + oldVal.replace(/"/g,'&quot;') + '" />'
    + '<span class="codicon codicon-check" title="Save (Enter)"></span>'
    + '<span class="codicon codicon-close" title="Cancel (Esc)"></span>';
  box.style.display = 'none';
  box.parentNode.insertBefore(edit, box.nextSibling);
  const input = edit.querySelector('input');
  input.focus();
  input.select();
  const commit = () => {
    const newVal = input.value;
    if (newVal !== oldVal && newVal.trim()) {
      vscode.postMessage({ type:'editValue', subject:subj, predicate:pred, oldValue:oldVal, newValue:newVal });
    }
    edit.remove();
    box.style.display = '';
  };
  const cancel = () => { edit.remove(); box.style.display = ''; };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel(); });
  edit.querySelector('.codicon-check').addEventListener('click', commit);
  edit.querySelector('.codicon-close').addEventListener('click', cancel);
}

document.addEventListener('click', e => {
  // edit object relationship
  const editRel = e.target.closest('.edit-rel-btn[data-edit-subj]');
  if (editRel) {
    e.preventDefault(); e.stopPropagation();
    vscode.postMessage({ type:'editRelationship', subject:editRel.dataset.editSubj, predicate:editRel.dataset.editPred, oldValue:editRel.dataset.editObj, oldLabel:editRel.dataset.editLabel||'', dir:editRel.dataset.editDir||'out' });
    return;
  }
  // delete
  const del = e.target.closest('.del-btn[data-del-subj]');
  if (del) {
    e.preventDefault(); e.stopPropagation();
    vscode.postMessage({ type:'delete', subject:del.dataset.delSubj, predicate:del.dataset.delPred, object:del.dataset.delObj, label:del.dataset.delLabel||'' });
    showToast('Removed', true);
    return;
  }
  // inline edit
  const editBox = e.target.closest('.edit-target[data-edit-subj]');
  if (editBox && !e.target.closest('.del-btn')) { startEdit(editBox); return; }
  // add from ghost row
  const add = e.target.closest('.add-btn[data-add-subj]');
  if (add) { e.preventDefault(); vscode.postMessage({ type:'addProperty', subject:add.dataset.addSubj, predicate:add.dataset.addPred, range:add.dataset.addRange, isObject:add.dataset.addIsobj==='true' }); return; }
  // add relationship
  const addRel = e.target.closest('.add-rel-btn[data-subj]');
  if (addRel) { e.preventDefault(); vscode.postMessage({ type:'addRelationship', subject:addRel.dataset.subj }); return; }
  // navigate
  const c = e.target.closest('a[data-iri]');
  if (c) { e.preventDefault(); vscode.postMessage({ type:'navigate', iri:c.dataset.iri }); }
});
document.addEventListener('contextmenu', e => {
  const c = e.target.closest('a[data-iri]');
  if (c) { e.preventDefault(); vscode.postMessage({ type:'goToDefinition', iri:c.dataset.iri }); }
});
// undo from toast
document.addEventListener('click', e => {
  if (e.target.id === 'toast-undo') { vscode.postMessage({ type:'undo' }); const t = document.getElementById('kg-toast'); if (t) t.remove(); }
});

// form handling
window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'showForm') renderForm(msg.form);
});

function renderForm(form) {
  const c = document.getElementById('form-container');
  if (!c) return;
  if (form.type === 'newClass') {
    c.innerHTML = newClassForm(form);
  } else if (form.type === 'newInstance') {
    c.innerHTML = newInstanceForm(form);
  } else if (form.type === 'editOntology' || form.type === 'editClass' || form.type === 'editEntity') {
    c.innerHTML = editForm(form);
  } else if (form.type === 'newProperty') {
    c.innerHTML = newPropertyForm(form);
  } else if (form.type === 'newOntology') {
    c.innerHTML = newOntologyForm(form);
  } else if (form.type === 'editRelationship') {
    c.innerHTML = editRelForm(form);
  } else if (form.type === 'editRelSearchResults') {
    var sel = document.getElementById('er-remote-entity');
    var resultField = document.getElementById('er-result-field');
    var status = document.getElementById('er-status');
    if (sel && form.results) {
      if (form.results.length > 0) {
        sel.innerHTML = form.results.map(function(r) { return '<option value="' + esc2(r.iri) + '">' + esc2(r.label) + '</option>'; }).join('');
        if (resultField) resultField.style.display = '';
        if (status) status.style.display = 'none';
        var submit = document.getElementById('er-submit');
        if (submit && form.results.length === 1) submit.disabled = false;
      } else {
        if (resultField) resultField.style.display = 'none';
        if (status) { status.textContent = 'No matches found. Try the exact username.'; status.style.display = ''; }
      }
    }
    return;
  } else if (form.type === 'addRelationship') {
    c.innerHTML = addRelForm(form);
  } else if (form.type === 'setFormValue') {
    const val = document.getElementById('ar-value');
    const submit = document.getElementById('ar-submit');
    const isObj = document.getElementById('ar-isObject');
    if (val) { val.value = form.value || ''; }
    if (isObj) { isObj.value = 'true'; }
    if (submit) { submit.disabled = false; }
    return;
  } else {
    c.innerHTML = '';
  }
  const first = c.querySelector('input');
  if (first) first.focus();
}

function closeForm() {
  const c = document.getElementById('form-container');
  if (c) c.innerHTML = '';
}

// close on backdrop click or Escape
document.addEventListener('click', e => {
  if (e.target && e.target.id === 'form-container') closeForm();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeForm();
});

function newClassForm(form) {
  var superOpts = '<option value="">(none)</option>';
  if (form.classes) {
    for (var i = 0; i < form.classes.length; i++) {
      superOpts += '<option value="' + esc2(form.classes[i].iri) + '">' + esc2(form.classes[i].label) + '</option>';
    }
  }
  return '<div class="form-card">'
    + '<div class="form-header"><span class="codicon codicon-symbol-class" style="font-size:16px;color:var(--accent)"></span><span class="form-header-title">New Class</span><span class="form-header-sub">' + esc2(form.ns || '') + '</span><span class="codicon codicon-close" data-action="closeForm" title="Cancel" style="font-size:15px;color:var(--fg-muted);cursor:pointer"></span></div>'
    + '<div class="form-body">'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Class name</span><span class="form-label-hint">PascalCase</span></div><input class="form-input" id="fc-name" placeholder="MyClassName" data-oninput="fcUpdate"></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Superclass</span><span class="form-label-hint">optional</span></div><select class="form-input" id="fc-super" style="height:28px">' + superOpts + '</select></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Label</span></div><input class="form-input" id="fc-label" placeholder="Display label"></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Comment</span><span class="form-label-hint">optional</span></div><textarea class="form-textarea" id="fc-comment" rows="2" placeholder="Description of the class"></textarea></div>'
    + '<div class="form-actions"><button class="form-btn form-btn-secondary" data-action="closeForm">Cancel</button><button class="form-btn form-btn-primary" id="fc-submit" data-action="fcSubmit" disabled>Create Class</button></div>'
    + '</div></div>';
}

function fcUpdate() {
  const name = document.getElementById('fc-name');
  const label = document.getElementById('fc-label');
  const submit = document.getElementById('fc-submit');
  if (!name || !label || !submit) return;
  const valid = /^[A-Z][\\w]*$/.test(name.value);
  submit.disabled = !valid || !name.value;
  if (label.value === '' || label.dataset.auto !== 'false') {
    label.value = name.value.replace(/([A-Z])/g, ' $1').trim();
    label.dataset.auto = 'true';
  }
}

function fcSubmit() {
  const name = document.getElementById('fc-name');
  const label = document.getElementById('fc-label');
  const comment = document.getElementById('fc-comment');
  const superSel = document.getElementById('fc-super');
  if (!name || !name.value) return;
  vscode.postMessage({ type:'createClass', name:name.value, label:label?.value||name.value, comment:comment?.value||'', ns:'', superclass:superSel?.value||'' });
  closeForm();
  showToast('Created class "' + name.value + '"', false);
}

function newInstanceForm(form) {
  return '<div class="form-card">'
    + '<div class="form-header"><span class="codicon codicon-symbol-field" style="font-size:16px;color:var(--accent)"></span><span class="form-header-title">New ' + esc2(form.className || 'Instance') + '</span><span class="codicon codicon-close" data-action="closeForm" title="Cancel" style="font-size:15px;color:var(--fg-muted);cursor:pointer"></span></div>'
    + '<div class="form-body">'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Local name</span><span class="form-label-hint">IRI-safe identifier</span></div><input class="form-input" id="fi-name" placeholder="my-entity-name" data-oninput="fiUpdate"></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Label</span></div><input class="form-input" id="fi-label" placeholder="Display label"></div>'
    + '<input type="hidden" id="fi-classIri" value="' + esc2(form.classIri || '') + '">'
    + '<div class="form-actions"><button class="form-btn form-btn-secondary" data-action="closeForm">Cancel</button><button class="form-btn form-btn-primary" id="fi-submit" data-action="fiSubmit" disabled>Create Instance</button></div>'
    + '</div></div>';
}

function fiUpdate() {
  const name = document.getElementById('fi-name');
  const label = document.getElementById('fi-label');
  const submit = document.getElementById('fi-submit');
  if (!name || !label || !submit) return;
  const valid = /^[a-zA-Z_][\\w.-]*$/.test(name.value);
  submit.disabled = !valid || !name.value;
  if (label.value === '' || label.dataset.auto !== 'false') {
    label.value = name.value.replace(/[-_]/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());
    label.dataset.auto = 'true';
  }
}

function fiSubmit() {
  const name = document.getElementById('fi-name');
  const label = document.getElementById('fi-label');
  const classIri = document.getElementById('fi-classIri');
  if (!name || !name.value) return;
  vscode.postMessage({ type:'createInstance', localName:name.value, label:label?.value||name.value, classIri:classIri?.value||'' });
  closeForm();
  showToast('Created instance "' + (label?.value || name.value) + '"', false);
}

function editForm(form) {
  const kind = form.type === 'editOntology' ? 'Ontology' : form.type === 'editClass' ? 'Class' : 'Entity';
  const icon = form.type === 'editOntology' ? 'codicon-symbol-namespace' : form.type === 'editClass' ? 'codicon-symbol-class' : 'codicon-symbol-field';
  var nsField = '';
  if (form.type === 'editOntology') {
    nsField = '<div class="form-field"><div class="form-label"><span class="form-label-text">Namespace URI</span></div><input class="form-input mono" id="ed-ns" value="' + esc2(form.iri || form.ns || '') + '" style="font-size:12px"></div>';
  }
  return '<div class="form-card">'
    + '<div class="form-header"><span class="codicon ' + icon + '" style="font-size:16px;color:var(--accent)"></span><span class="form-header-title">Edit ' + kind + '</span><span class="codicon codicon-close" data-action="closeForm" title="Cancel" style="font-size:15px;color:var(--fg-muted);cursor:pointer"></span></div>'
    + '<div class="form-body">'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Label</span></div><input class="form-input" id="ed-label" value="' + esc2(form.label || '') + '"></div>'
    + nsField
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Comment</span><span class="form-label-hint">optional</span></div><textarea class="form-textarea" id="ed-comment" rows="3">' + esc2(form.comment || '') + '</textarea></div>'
    + '<input type="hidden" id="ed-iri" value="' + esc2(form.iri || form.ns || '') + '">'
    + '<input type="hidden" id="ed-type" value="' + esc2(form.type) + '">'
    + '<div class="form-actions"><button class="form-btn form-btn-secondary" data-action="closeForm">Cancel</button><button class="form-btn form-btn-primary" data-action="edSubmit">Save</button></div>'
    + '</div></div>';
}

function edSubmit() {
  const label = document.getElementById('ed-label');
  const comment = document.getElementById('ed-comment');
  const iri = document.getElementById('ed-iri');
  const type = document.getElementById('ed-type');
  const nsEl = document.getElementById('ed-ns');
  if (!label || !iri || !type) return;
  vscode.postMessage({ type: 'saveEdit', editType: type.value, iri: iri.value, label: label.value, comment: comment ? comment.value : '', ns: nsEl ? nsEl.value : '' });
  closeForm();
  showToast('Saved', false);
}

function newPropertyForm(form) {
  var classOpts = '';
  if (form.classes && form.classes.length > 0) {
    for (var ci = 0; ci < form.classes.length; ci++) {
      classOpts += '<option value="' + esc2(form.classes[ci].iri) + '">' + esc2(form.classes[ci].label) + '</option>';
    }
  }
  var dtOpts = '<option value="xsd:string">string</option><option value="xsd:integer">integer</option>'
    + '<option value="xsd:decimal">decimal</option><option value="xsd:boolean">boolean</option>'
    + '<option value="xsd:date">date</option><option value="xsd:dateTime">dateTime</option>'
    + '<option value="xsd:anyURI">anyURI</option>';
  return '<div class="form-card">'
    + '<div class="form-header"><span class="codicon codicon-symbol-field" style="font-size:16px;color:var(--accent)"></span><span class="form-header-title">New Property</span><span class="form-header-sub">on ' + esc2(form.className || '') + '</span><span class="codicon codicon-close" data-action="closeForm" title="Cancel" style="font-size:15px;color:var(--fg-muted);cursor:pointer"></span></div>'
    + '<div class="form-body">'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Property name</span><span class="form-label-hint">camelCase</span></div><input class="form-input" id="fp-name" placeholder="myProperty" data-oninput="fpUpdate"></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Kind</span></div><select class="form-input" id="fp-kind" style="height:28px" data-oninput="fpKindChange"><option value="object">Object Property (→ entity)</option><option value="datatype">Datatype Property (→ value)</option></select></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Range</span><span class="form-label-hint" id="fp-range-hint">target class</span></div><select class="form-input" id="fp-range" style="height:28px" data-oninput="fpUpdate">' + classOpts + '</select></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Label</span></div><input class="form-input" id="fp-label" placeholder="Display label" data-oninput="fpUpdate"></div>'
    + '<input type="hidden" id="fp-classIri" value="' + esc2(form.classIri || '') + '">'
    + '<input type="hidden" id="fp-class-opts" value="' + esc2(classOpts) + '">'
    + '<input type="hidden" id="fp-dt-opts" value="' + esc2(dtOpts) + '">'
    + '<div class="form-actions"><button class="form-btn form-btn-secondary" data-action="closeForm">Cancel</button><button class="form-btn form-btn-primary" id="fp-submit" data-action="fpSubmit" disabled>Add Property</button></div>'
    + '</div></div>';
}

function fpKindChange() {
  var kindSel = document.getElementById('fp-kind');
  var rangeSel = document.getElementById('fp-range');
  var rangeHint = document.getElementById('fp-range-hint');
  var classOptsEl = document.getElementById('fp-class-opts');
  var dtOptsEl = document.getElementById('fp-dt-opts');
  if (!kindSel || !rangeSel || !classOptsEl || !dtOptsEl) return;
  if (kindSel.value === 'datatype') {
    rangeSel.innerHTML = dtOptsEl.value;
    if (rangeHint) rangeHint.textContent = 'value type';
  } else {
    rangeSel.innerHTML = classOptsEl.value;
    if (rangeHint) rangeHint.textContent = 'target class';
  }
  fpUpdate();
}

function fpUpdate() {
  var name = document.getElementById('fp-name');
  var label = document.getElementById('fp-label');
  var submit = document.getElementById('fp-submit');
  if (!name || !label || !submit) return;
  var valid = /^[a-z][a-zA-Z0-9]*$/.test(name.value);
  submit.disabled = !valid || !name.value;
  if (label.dataset.auto !== 'false' && name.value) {
    label.value = name.value.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    label.dataset.auto = 'true';
  }
}

function fpSubmit() {
  var name = document.getElementById('fp-name');
  var label = document.getElementById('fp-label');
  var classIri = document.getElementById('fp-classIri');
  var rangeSel = document.getElementById('fp-range');
  var kindSel = document.getElementById('fp-kind');
  if (!name || !name.value || !classIri || !rangeSel || !kindSel) return;
  var range = rangeSel.value;
  var kind = kindSel.value;
  vscode.postMessage({ type: 'createProperty', name: name.value, label: label ? label.value : name.value, kind: kind, range: range, classIri: classIri.value });
  closeForm();
  showToast('Added property "' + (label ? label.value : name.value) + '"', false);
}

function newOntologyForm(form) {
  return '<div class="form-card">'
    + '<div class="form-header"><span class="codicon codicon-symbol-namespace" style="font-size:16px;color:var(--accent)"></span><span class="form-header-title">New Ontology</span><span class="codicon codicon-close" data-action="closeForm" title="Cancel" style="font-size:15px;color:var(--fg-muted);cursor:pointer"></span></div>'
    + '<div class="form-body">'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Name</span></div><input class="form-input" id="fo-name" placeholder="My Domain Ontology" data-oninput="foUpdate"></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Prefix</span><span class="form-label-hint">short namespace alias (e.g. bill)</span></div><input class="form-input" id="fo-prefix" placeholder="myns" data-oninput="foUpdate"></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Namespace URI</span><span class="form-label-hint">must end with # or /</span></div><input class="form-input" id="fo-ns" placeholder="https://example.org/ontology#" data-oninput="foUpdate"></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Description</span><span class="form-label-hint">optional</span></div><textarea class="form-textarea" id="fo-desc" rows="2" placeholder="What this ontology models"></textarea></div>'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">File name</span></div><input class="form-input" id="fo-file" placeholder="my-ontology.ttl" data-oninput="foUpdate"></div>'
    + '<div id="fo-error" class="form-error" style="display:none"></div>'
    + '<div class="form-actions"><button class="form-btn form-btn-secondary" data-action="closeForm">Cancel</button><button class="form-btn form-btn-primary" id="fo-submit" data-action="foSubmit" disabled>Create Ontology</button></div>'
    + '</div></div>';
}

function foUpdate(e) {
  const name = document.getElementById('fo-name');
  const prefix = document.getElementById('fo-prefix');
  const ns = document.getElementById('fo-ns');
  const file = document.getElementById('fo-file');
  const submit = document.getElementById('fo-submit');
  const error = document.getElementById('fo-error');
  if (!name || !prefix || !ns || !file || !submit) return;

  // track which field the user is editing to stop auto-fill for that field
  var active = document.activeElement;
  if (active === prefix) prefix.dataset.auto = 'false';
  if (active === ns) ns.dataset.auto = 'false';
  if (active === file) file.dataset.auto = 'false';

  // auto-fill only untouched fields
  if (prefix.dataset.auto !== 'false' && name.value) {
    prefix.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 6);
  }
  if (ns.dataset.auto !== 'false' && prefix.value) {
    ns.value = 'https://example.org/ns/' + prefix.value + '#';
  }
  if (file.dataset.auto !== 'false' && name.value) {
    file.value = name.value.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-ontology.ttl';
  }

  // validate
  var valid = true;
  var errMsg = '';
  if (!name.value) { valid = false; }
  if (prefix.value && !/^[a-zA-Z][a-zA-Z0-9]*$/.test(prefix.value)) { valid = false; errMsg = 'Prefix must start with a letter, letters and numbers only'; }
  if (ns.value && !ns.value.endsWith('#') && !ns.value.endsWith('/')) { valid = false; errMsg = 'Namespace must end with # or /'; }
  if (!file.value || !file.value.endsWith('.ttl')) { valid = false; errMsg = 'File must end with .ttl'; }

  if (error) { error.textContent = errMsg; error.style.display = errMsg ? 'block' : 'none'; }
  submit.disabled = !valid || !name.value || !prefix.value || !ns.value || !file.value;
}

function foSubmit() {
  const name = document.getElementById('fo-name');
  const prefix = document.getElementById('fo-prefix');
  const ns = document.getElementById('fo-ns');
  const desc = document.getElementById('fo-desc');
  const file = document.getElementById('fo-file');
  if (!name || !name.value || !prefix || !ns || !file) return;
  vscode.postMessage({ type:'createOntology', name:name.value, prefix:prefix.value, ns:ns.value, desc:desc?.value||'', file:file.value });
  closeForm();
  showToast('Created ontology "' + name.value + '"', false);
}

function editRelForm(form) {
  var oldLabel = form.oldLabel || '';
  try { oldLabel = decodeURIComponent(oldLabel); } catch(e) {}
  var hasLocal = form.localOptions && form.localOptions.length > 0;
  var needsSearch = form.hasRemote && !hasLocal;

  var localOpts = '';
  if (hasLocal) {
    for (var i = 0; i < form.localOptions.length; i++) {
      var sel = form.localOptions[i].iri === form.oldValue ? ' selected' : '';
      localOpts += '<option value="' + esc2(form.localOptions[i].iri) + '"' + sel + '>' + esc2(form.localOptions[i].label) + '</option>';
    }
  }

  var body = '<div class="form-field"><div class="form-label"><span class="form-label-text">Current</span></div><div style="font-size:12px;color:var(--fg-muted);padding:4px 0">' + esc2(oldLabel) + '</div></div>';

  if (hasLocal) {
    body += '<div class="form-field"><div class="form-label"><span class="form-label-text">New value</span></div><select class="form-input" id="er-entity" style="height:28px" data-oninput="erSelect">' + localOpts + '</select></div>';
  }

  if (needsSearch) {
    body += '<div class="form-field"><div class="form-label"><span class="form-label-text">Search remote</span><span class="form-label-hint">type exact username</span></div><input class="form-input" id="er-search" placeholder="e.g. avesand" autocomplete="off" data-oninput="erSearch"></div>';
    body += '<div class="form-field" id="er-result-field" style="display:none"><div class="form-label"><span class="form-label-text">Remote result</span></div><select class="form-input" id="er-remote-entity" style="height:28px" data-oninput="erRemoteSelect"></select></div>';
    body += '<div id="er-status" style="font-size:11px;color:var(--fg-muted);padding:2px 0;display:none"></div>';
  }

  return '<div class="form-card">'
    + '<div class="form-header"><span class="codicon codicon-edit" style="font-size:16px;color:var(--accent)"></span><span class="form-header-title">Edit Relationship</span><span class="codicon codicon-close" data-action="closeForm" title="Cancel" style="font-size:15px;color:var(--fg-muted);cursor:pointer"></span></div>'
    + '<div class="form-body">' + body
    + '<input type="hidden" id="er-subject" value="' + esc2(form.subject || '') + '">'
    + '<input type="hidden" id="er-predicate" value="' + esc2(form.predicate || '') + '">'
    + '<input type="hidden" id="er-oldValue" value="' + esc2(form.oldValue || '') + '">'
    + '<input type="hidden" id="er-oldLabel" value="' + esc2(form.oldLabel || '') + '">'
    + '<input type="hidden" id="er-targetType" value="' + esc2(form.targetType || '') + '">'
    + '<div class="form-actions"><button class="form-btn form-btn-secondary" data-action="closeForm">Cancel</button><button class="form-btn form-btn-primary" id="er-submit" data-action="erSubmit"' + (hasLocal ? '' : ' disabled') + '>Save</button></div>'
    + '</div></div>';
}

var erDebounce;
var erLastQuery = '';
function erSearch() {
  var search = document.getElementById('er-search');
  var targetType = document.getElementById('er-targetType');
  var status = document.getElementById('er-status');
  var resultField = document.getElementById('er-result-field');
  if (!search || !targetType) return;
  if (search.value.length < 2) {
    if (resultField) resultField.style.display = 'none';
    if (status) status.style.display = 'none';
    return;
  }
  if (search.value === erLastQuery) return;
  if (erDebounce) clearTimeout(erDebounce);
  erDebounce = setTimeout(function() {
    erLastQuery = search.value;
    if (status) { status.textContent = 'Searching...'; status.style.display = ''; }
    vscode.postMessage({ type: 'searchEditRel', query: search.value, targetType: targetType.value });
  }, 500);
}

function erSelect() {
  var submit = document.getElementById('er-submit');
  if (submit) submit.disabled = false;
  // Clear remote selection when local is picked
  var remote = document.getElementById('er-remote-entity');
  if (remote) remote.selectedIndex = -1;
}

function erRemoteSelect() {
  var submit = document.getElementById('er-submit');
  if (submit) submit.disabled = false;
  // Clear local selection when remote is picked
  var local = document.getElementById('er-entity');
  if (local) local.selectedIndex = -1;
}

function erSubmit() {
  var subject = document.getElementById('er-subject');
  var predicate = document.getElementById('er-predicate');
  var oldValue = document.getElementById('er-oldValue');
  var oldLabel = document.getElementById('er-oldLabel');
  // Prefer remote selection if set, otherwise local
  var remote = document.getElementById('er-remote-entity');
  var local = document.getElementById('er-entity');
  var newValue = (remote && remote.value) || (local && local.value) || '';
  if (!subject || !predicate || !oldValue || !newValue) return;
  vscode.postMessage({ type: 'commitEditRel', subject: subject.value, predicate: predicate.value, oldValue: oldValue.value, newValue: newValue, oldLabel: oldLabel ? oldLabel.value : '' });
  closeForm();
  showToast('Relationship updated', false);
}

function addRelForm(form) {
  let opts = '';
  var predRanges = {};
  if (form.predicates) {
    for (var pi = 0; pi < form.predicates.length; pi++) {
      var p = form.predicates[pi];
      opts += '<option value="' + esc2(p.iri) + '" data-range="' + esc2(p.rangeIri || '') + '">' + esc2(p.label) + (p.range ? ' → ' + esc2(p.range) : '') + '</option>';
      if (p.rangeIri) predRanges[p.iri] = p.rangeIri;
    }
  }
  var entityOptsMap = {};
  if (form.rangeEntities) {
    for (var rk in form.rangeEntities) {
      var ents = form.rangeEntities[rk];
      var eopts = '';
      for (var ei = 0; ei < ents.length; ei++) {
        eopts += '<option value="' + esc2(ents[ei].iri) + '">' + esc2(ents[ei].label) + '</option>';
      }
      entityOptsMap[rk] = eopts;
    }
  }
  return '<div class="form-card">'
    + '<div class="form-header"><span class="codicon codicon-add" style="font-size:16px;color:var(--accent)"></span><span class="form-header-title">Add Relationship</span><span class="codicon codicon-close" data-action="closeForm" title="Cancel" style="font-size:15px;color:var(--fg-muted);cursor:pointer"></span></div>'
    + '<div class="form-body">'
    + '<div class="form-field"><div class="form-label"><span class="form-label-text">Property</span></div><select class="form-input" id="ar-pred" style="height:28px" data-oninput="arUpdate">' + opts + '</select></div>'
    + '<div class="form-field" id="ar-value-field"><div class="form-label"><span class="form-label-text">Value</span><span class="form-label-hint" id="ar-hint"></span></div><input class="form-input" id="ar-value" placeholder="Enter value..." data-oninput="arUpdate"></div>'
    + '<div class="form-field" id="ar-entity-field" style="display:none"><div class="form-label"><span class="form-label-text">Entity</span><span class="form-label-hint" id="ar-entity-hint"></span></div><select class="form-input" id="ar-entity" style="height:28px" data-oninput="arUpdate"></select></div>'
    + '<input type="hidden" id="ar-subject" value="' + esc2(form.subject || '') + '">'
    + '<input type="hidden" id="ar-isObject" value="false">'
    + '<input type="hidden" id="ar-range" value="">'
    + '<input type="hidden" id="ar-entity-opts" value="' + esc2(JSON.stringify(entityOptsMap)) + '">'
    + '<input type="hidden" id="ar-pred-ranges" value="' + esc2(JSON.stringify(predRanges)) + '">'
    + '<div class="form-actions"><button class="form-btn form-btn-secondary" data-action="closeForm">Cancel</button><button class="form-btn form-btn-primary" id="ar-submit" data-action="arSubmit" disabled>Add</button></div>'
    + '</div></div>';
}

function arUpdate() {
  var pred = document.getElementById('ar-pred');
  var value = document.getElementById('ar-value');
  var entitySel = document.getElementById('ar-entity');
  var valueField = document.getElementById('ar-value-field');
  var entityField = document.getElementById('ar-entity-field');
  var submit = document.getElementById('ar-submit');
  var hint = document.getElementById('ar-hint');
  var entityHint = document.getElementById('ar-entity-hint');
  var isObjEl = document.getElementById('ar-isObject');
  var rangeEl = document.getElementById('ar-range');
  var entityOptsEl = document.getElementById('ar-entity-opts');
  var predRangesEl = document.getElementById('ar-pred-ranges');
  if (!pred || !submit) return;
  var opt = pred.options[pred.selectedIndex];
  var label = opt ? opt.textContent : '';
  var hasArrow = label.includes('→');
  var rangeName = hasArrow ? label.split('→')[1].trim() : '';
  var predRanges = {};
  var entityOpts = {};
  try { predRanges = JSON.parse(predRangesEl ? predRangesEl.value : '{}'); } catch(e) {}
  try { entityOpts = JSON.parse(entityOptsEl ? entityOptsEl.value : '{}'); } catch(e) {}
  var rangeIri = predRanges[pred.value] || '';
  var hasEntities = rangeIri && entityOpts[rangeIri] && entityOpts[rangeIri].length > 0;
  if (hasEntities && entitySel && valueField && entityField) {
    valueField.style.display = 'none';
    entityField.style.display = '';
    entitySel.innerHTML = entityOpts[rangeIri];
    if (entityHint) entityHint.textContent = rangeName;
    if (isObjEl) isObjEl.value = 'true';
    if (rangeEl) rangeEl.value = rangeName;
    submit.disabled = !entitySel.value;
  } else {
    if (valueField) valueField.style.display = '';
    if (entityField) entityField.style.display = 'none';
    if (hint) hint.textContent = rangeName ? 'Expected: ' + rangeName : '';
    if (isObjEl) isObjEl.value = hasArrow ? 'true' : 'false';
    if (rangeEl) rangeEl.value = rangeName;
    submit.disabled = !(value && value.value);
  }
}

function arSubmit() {
  var pred = document.getElementById('ar-pred');
  var value = document.getElementById('ar-value');
  var entitySel = document.getElementById('ar-entity');
  var entityField = document.getElementById('ar-entity-field');
  var subject = document.getElementById('ar-subject');
  var isObj = document.getElementById('ar-isObject');
  if (!pred || !subject) return;
  var useEntity = entityField && entityField.style.display !== 'none' && entitySel && entitySel.value;
  var val = useEntity ? entitySel.value : (value ? value.value : '');
  if (!val) return;
  var isObject = useEntity || (isObj && isObj.value === 'true');
  vscode.postMessage({ type: 'commitAddRel', subject: subject.value, predicate: pred.value, value: val, isObject: isObject });
  closeForm();
  showToast('Relationship added', false);
}

function arPickEntity() {
  const pred = document.getElementById('ar-pred');
  const subject = document.getElementById('ar-subject');
  const rangeEl = document.getElementById('ar-range');
  if (!pred || !subject) return;
  vscode.postMessage({ type: 'pickEntity', subject: subject.value, predicate: pred.value, range: rangeEl ? rangeEl.value : '' });
}

function esc2(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// event delegation for data-action buttons
const actionHandlers = {
  closeForm, fcSubmit, fiSubmit, foSubmit, fpSubmit, fpKindChange, edSubmit, arSubmit, arPick: arPickEntity, erSubmit,
  editOntology: (el) => vscode.postMessage({type:'showEditForm',editType:'editOntology',iri:el.dataset.ns||'',label:el.dataset.label||'',comment:el.dataset.comment||''}),
  editClass: (el) => vscode.postMessage({type:'showEditForm',editType:'editClass',iri:el.dataset.iri||'',label:el.dataset.label||'',comment:el.dataset.comment||''}),
  editEntity: (el) => vscode.postMessage({type:'showEditForm',editType:'editEntity',iri:el.dataset.iri||'',label:el.dataset.label||'',comment:el.dataset.comment||''}),
  newClass: (el) => vscode.postMessage({type:'newClass',ns:el.dataset.ns||''}),
  newProperty: (el) => vscode.postMessage({type:'newProperty',ns:el.dataset.ns||''}),
  newProp: (el) => vscode.postMessage({type:'newProp',classIri:el.dataset.classIri||'',className:el.dataset.className||''}),
  newInst: (el) => vscode.postMessage({type:'newInst',classIri:el.dataset.classIri||'',className:el.dataset.className||''}),
  addImport: (el) => vscode.postMessage({type:'addImport',ns:el.dataset.ns||''}),
  removeImport: (el) => vscode.postMessage({type:'removeImport',ns:el.dataset.ns||'',import:el.dataset.import||''})
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (el) { const fn = actionHandlers[el.dataset.action]; if (fn) fn(el); }
});
// event delegation for data-oninput
const inputHandlers = { fcUpdate, fiUpdate, foUpdate, fpUpdate, fpKindChange, arUpdate, erSearch, erSelect, erRemoteSelect };
document.addEventListener('input', e => {
  const el = e.target.closest('[data-oninput]');
  if (el) { const fn = inputHandlers[el.dataset.oninput]; if (fn) fn(); }
});
</script>
</body></html>`;
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
  }
}

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
