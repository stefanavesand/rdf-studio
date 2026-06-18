import * as vscode from 'vscode';
import { RdfStore } from './store/RdfStore';
import { OntologyTreeProvider, TreeNode } from './tree/OntologyTreeProvider';
import { RelationshipsWebview } from './RelationshipsWebview';
import { SparqlPanel } from './SparqlPanel';
import { TurtleHoverProvider } from './TurtleHoverProvider';
import { TurtleDefinitionProvider } from './TurtleDefinitionProvider';
import { TurtleCompletionProvider } from './TurtleCompletionProvider';
import { TurtleSymbolProvider } from './TurtleSymbolProvider';
import { GraphPanel } from './GraphPanel';
import { TurtleDiagnostics } from './TurtleDiagnostics';
import { TurtleEditor } from './store/TurtleEditor';

let store: RdfStore;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractIri(arg: any): string | undefined {
  if (typeof arg === 'string') { return arg; }
  if (!arg) { return undefined; }
  if (arg.iri) { return arg.iri; }
  if (arg.data?.iri) { return arg.data.iri; }
  if (arg.targetIri) { return arg.targetIri; }
  if (arg.value && arg.isIri) { return arg.value; }
  if (arg.id && typeof arg.id === 'string') { return arg.id; }
  return undefined;
}

function isOwlClass(iri: string): boolean {
  const rows = store.query(`SELECT ?x WHERE { <${iri}> a owl:Class } LIMIT 1`);
  return rows.length > 0;
}

interface SavedEndpoint { name: string; url: string }
const ENDPOINTS_KEY = 'rdfStudio.savedEndpoints';

function getSavedEndpoints(context: vscode.ExtensionContext): SavedEndpoint[] {
  return context.workspaceState.get<SavedEndpoint[]>(ENDPOINTS_KEY, []);
}

function saveEndpoints(context: vscode.ExtensionContext, endpoints: SavedEndpoint[]): void {
  context.workspaceState.update(ENDPOINTS_KEY, endpoints);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  store = new RdfStore();

  const ontologyProvider = new OntologyTreeProvider(store);
  const relationshipsProvider = new RelationshipsWebview(store);
  relationshipsProvider.setExtensionUri(context.extensionUri);
  const sparqlPanel = new SparqlPanel(store, context.extensionUri);
  const graphPanel = new GraphPanel(store);
  const diagnostics = new TurtleDiagnostics(store);
  const editor = new TurtleEditor(store);
  const turtleSelector: vscode.DocumentSelector = { language: 'turtle' };

  const ontologyTree = vscode.window.createTreeView('kgExplorer.ontology', {
    treeDataProvider: ontologyProvider,
    showCollapseAll: true,
  });

  function revealInOntology(iri: string): void {
    try {
      // Try local first, then remote-prefixed
      let node = ontologyProvider.findNode(iri);
      if (!node) { node = ontologyProvider.findNode(`local:${iri}`); }
      if (!node) { node = ontologyProvider.findNode(`remote:${iri}`); }
      if (node) {
        ontologyTree.reveal(node, { select: true, focus: false, expand: false });
      }
    } catch { /* reveal is best-effort */ }
  }

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'kgExplorer.search';
  statusBar.tooltip = 'Search Knowledge Graph';

  const updateStatus = () => {
    if (store.isLoaded && store.tripleCount > 0) {
      statusBar.text = `$(symbol-structure) ${store.tripleCount} triples`;
      statusBar.show();
    } else {
      statusBar.hide();
    }
  };

  store.onDidReload(updateStatus);

  context.subscriptions.push(
    ontologyTree,
    vscode.window.registerWebviewViewProvider('kgExplorer.relationships', relationshipsProvider),

    vscode.commands.registerCommand('kgExplorer.refresh', async () => {
      await loadAllTtl();
      vscode.window.showInformationMessage(`KG Explorer: Loaded ${store.tripleCount} triples`);
    }),

    vscode.commands.registerCommand('kgExplorer.newOntology', async () => {
      await vscode.commands.executeCommand('kgExplorer.relationships.focus');
      // small delay to let the panel render before posting the form
      setTimeout(() => relationshipsProvider.showForm({ type: 'newOntology' }), 100);
    }),

    vscode.commands.registerCommand('kgExplorer.commitNewOntology', async (name: string, prefix: string, ns: string, desc: string, fileName: string) => {
      try {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          vscode.window.showWarningMessage('No workspace folder open');
          return;
        }
        const targetUri = vscode.Uri.joinPath(workspaceFolders[0].uri, fileName);

        // check if file exists
        try {
          await vscode.workspace.fs.stat(targetUri);
          vscode.window.showWarningMessage(`File ${fileName} already exists`);
          return;
        } catch { /* file doesn't exist — good */ }

        const today = new Date().toISOString().slice(0, 10);
        let content = `@prefix ${prefix}: <${ns}> .\n`;
        content += `@prefix : <${ns.replace(/#$/, '/').replace(/\/+$/, '/')}> .\n`;
        content += `@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n`;
        content += `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n`;
        content += `@prefix owl: <http://www.w3.org/2002/07/owl#> .\n`;
        content += `@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n`;
        content += `@prefix dcterms: <http://purl.org/dc/terms/> .\n`;
        content += `\n`;
        content += `${prefix}: a owl:Ontology ;\n`;
        content += `    rdfs:label "${name}"`;
        if (desc) { content += ` ;\n    rdfs:comment "${desc}"`; }
        content += ` ;\n    dcterms:created "${today}"^^xsd:date .\n`;

        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(content, 'utf-8'));
        await loadAllTtl();
        relationshipsProvider.selectNamespace(ns, name);
        const doc = await vscode.workspace.openTextDocument(targetUri);
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to create ontology: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.showProperties', async (arg: unknown) => {
      try {
        const nodeKind = typeof arg === 'object' && arg !== null && 'kind' in arg ? (arg as any).kind as string : undefined;
        if (nodeKind === 'namespace') {
          const ns = (arg as any).ns as string;
          const label = (arg as any).label as string;
          relationshipsProvider.selectNamespace(ns, label);
          return;
        }
        const iri = extractIri(arg);
        if (!iri) { return; }
        const isClass = nodeKind === 'class';
        const isRemoteNode = typeof arg === 'object' && arg !== null && 'sourceType' in arg && (arg as any).sourceType === 'remote';
        // Auto-detect remote: if not from a tree node, check if the IRI is in local files
        const isRemote = isRemoteNode || (!nodeKind && !store.isLocalIri(iri) && store.getRemoteEndpoints().size > 0);

        if (isRemote && !isClass && iri) {
          const remotes = store.getRemoteEndpoints();
          const endpointUrl = remotes.size > 0 ? [...remotes.keys()][0] : undefined;
          await relationshipsProvider.selectRemote(iri, endpointUrl ?? '');
        } else {
          relationshipsProvider.select(iri, isClass, isRemote);
        }
        // Always try to reveal in ontology tree
        setTimeout(() => revealInOntology(iri), 200);
      } catch (e) {
        console.error('kgExplorer.showProperties error:', e);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.goToDefinition', async (arg: unknown) => {
      // handle namespace nodes
      if (typeof arg === 'object' && arg !== null && 'kind' in arg && (arg as any).kind === 'namespace') {
        const ns = (arg as any).ns as string;
        const files = await vscode.workspace.findFiles('**/*.ttl', '**/node_modules/**', 50);
        for (const f of files) {
          const content = (await vscode.workspace.fs.readFile(f)).toString();
          if (content.includes(ns)) {
            const doc = await vscode.workspace.openTextDocument(f);
            await vscode.window.showTextDocument(doc);
            return;
          }
        }
        vscode.window.showWarningMessage(`No source file found for ${ns}`);
        return;
      }
      const iri = extractIri(arg);
      if (!iri) { return; }
      const loc = store.getDefinitionLocation(iri);
      if (!loc) {
        vscode.window.showWarningMessage(`No source location found for ${store.compact(iri)}`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(loc.uri);
      const ed = await vscode.window.showTextDocument(doc);
      const range = new vscode.Range(loc.line, 0, loc.line, 0);
      ed.selection = new vscode.Selection(range.start, range.start);
      ed.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }),

    vscode.commands.registerCommand('kgExplorer.search', async () => {
      const rows = store.query(`
        SELECT DISTINCT ?s ?label ?type WHERE {
          ?s a ?type .
          ?type a <http://www.w3.org/2002/07/owl#Class> .
          OPTIONAL { ?s rdfs:label ?label }
          FILTER(isIRI(?s))
        } ORDER BY ?label LIMIT 500
      `);

      const items = rows.map(row => {
        const iri = row.get('s')!.value;
        const label = row.get('label')?.value ?? store.localName(iri);
        const typeLabel = store.localName(row.get('type')!.value);
        return { label, description: typeLabel, detail: store.compact(iri), iri };
      });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Search instances by name...',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (picked) {
        relationshipsProvider.select(picked.iri);
        revealInOntology(picked.iri);
        const loc = store.getDefinitionLocation(picked.iri);
        if (loc) {
          const doc = await vscode.workspace.openTextDocument(loc.uri);
          const editor = await vscode.window.showTextDocument(doc);
          const range = new vscode.Range(loc.line, 0, loc.line, 0);
          editor.selection = new vscode.Selection(range.start, range.start);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        }
      }
    }),

    vscode.commands.registerCommand('kgExplorer.saveEdit', async (editType: string, iri: string, newLabel: string, newComment: string, newNs?: string) => {
      try {
        // find the entity in a TTL file and update its label and comment
        const loc = store.getDefinitionLocation(iri);
        if (!loc) {
          vscode.window.showWarningMessage('Could not find source location');
          return;
        }

        const doc = await vscode.workspace.openTextDocument(loc.uri);
        const text = doc.getText();
        const lines = text.split('\n');
        const subjectLine = loc.line;

        // find block end (skip triple-quoted strings)
        let blockEnd = subjectLine;
        let inTripleQuote = false;
        for (let i = subjectLine; i < lines.length; i++) {
          const tq = (lines[i].match(/"""/g) || []).length;
          if (tq % 2 !== 0) { inTripleQuote = !inTripleQuote; }
          if (!inTripleQuote && lines[i].trimEnd().endsWith('.')) { blockEnd = i; break; }
        }

        // get current label and comment
        const oldLabel = store.getLabel(iri);
        const oldComment = store.getComment(iri);

        const wsEdit = new vscode.WorkspaceEdit();

        // update namespace if changed (ontology only)
        if (editType === 'editOntology' && newNs && newNs !== iri) {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes(`<${iri}>`)) {
              wsEdit.replace(loc.uri, new vscode.Range(i, 0, i, lines[i].length),
                lines[i].replace(`<${iri}>`, `<${newNs}>`));
            }
          }
        }

        // update label if changed
        if (newLabel && newLabel !== oldLabel) {
          for (let i = subjectLine; i <= blockEnd; i++) {
            if (lines[i].includes('rdfs:label') && oldLabel && lines[i].includes(oldLabel)) {
              const updated = lines[i].replace(`"${oldLabel}"`, `"${newLabel}"`);
              wsEdit.replace(loc.uri, new vscode.Range(i, 0, i, lines[i].length), updated);
              break;
            }
          }
        }

        // update comment if changed
        if (newComment !== (oldComment ?? '')) {
          let foundComment = false;
          for (let i = subjectLine; i <= blockEnd; i++) {
            if (lines[i].includes('rdfs:comment')) {
              foundComment = true;
              if (newComment) {
                // replace the comment value
                const updated = lines[i].replace(/"[^"]*"/, `"${newComment}"`);
                wsEdit.replace(loc.uri, new vscode.Range(i, 0, i, lines[i].length), updated);
              }
              break;
            }
          }
          // add comment if it didn't exist
          if (!foundComment && newComment) {
            const lastLine = lines[blockEnd];
            const dotPos = lastLine.lastIndexOf('.');
            const before = lastLine.substring(0, dotPos).trimEnd();
            wsEdit.replace(loc.uri,
              new vscode.Range(blockEnd, 0, blockEnd, lastLine.length),
              before + ` ;\n    rdfs:comment "${newComment}" .`
            );
          }
        }

        const ok = await vscode.workspace.applyEdit(wsEdit);
        if (ok) {
          await doc.save();
          await loadAllTtl();
          if (editType === 'editOntology') {
            const finalNs = (newNs && newNs !== iri) ? newNs : iri;
            relationshipsProvider.selectNamespace(finalNs, newLabel);
          } else if (editType === 'editClass') {
            relationshipsProvider.select(iri, true);
          } else {
            relationshipsProvider.select(iri, false);
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to save: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.newProperty', async (arg: unknown) => {
      let classIri: string | undefined;
      let classLabel: string | undefined;
      if (typeof arg === 'object' && arg !== null && 'kind' in arg && (arg as any).kind === 'class') {
        classIri = (arg as any).data?.iri;
        classLabel = (arg as any).data?.label;
      } else if (typeof arg === 'string') {
        // ns passed from ontology view button
        classIri = arg;
        classLabel = store.localName(arg);
      } else {
        classIri = extractIri(arg);
        classLabel = classIri ? store.localName(classIri) : undefined;
      }

      // find the ontology namespace for this class and its imports
      const localNs = classIri ? classIri.replace(/[^#/]*$/, '') : '';
      const importRows = localNs ? store.query(`
        SELECT ?imported WHERE {
          ?ont a owl:Ontology .
          FILTER(STRSTARTS(STR(?ont), "${localNs.replace(/#$/, '')}"))
          ?ont owl:imports ?imported .
        }
      `) : [];
      const allowedNs = new Set<string>();
      if (localNs) { allowedNs.add(localNs); }
      for (const r of importRows) {
        let imp = r.get('imported')!.value;
        if (!imp.endsWith('#') && !imp.endsWith('/')) { imp += '#'; }
        allowedNs.add(imp);
      }
      // also add standard vocabularies that are always useful
      allowedNs.add('http://www.w3.org/2002/07/owl#');
      allowedNs.add('http://www.w3.org/2000/01/rdf-schema#');

      const classRows = store.query(`
        SELECT DISTINCT ?cls ?label WHERE {
          ?cls a owl:Class .
          OPTIONAL { ?cls rdfs:label ?label }
        } ORDER BY ?label LIMIT 500
      `);
      const seen = new Set<string>();
      const classes = classRows
        .filter(r => {
          const iri = r.get('cls')!.value;
          if (seen.has(iri) || store.localName(iri).startsWith('http')) { return false; }
          seen.add(iri);
          if (allowedNs.size === 0) { return true; }
          const ns = iri.replace(/[^#/]*$/, '');
          return allowedNs.has(ns);
        })
        .map(r => {
          const iri = r.get('cls')!.value;
          const localName = r.get('label')?.value ?? store.localName(iri);
          const compact = store.compact(iri);
          const prefix = compact.includes(':') ? compact.split(':')[0] + ':' : '';
          return { iri, label: prefix ? `${localName} (${prefix})` : localName };
        });

      relationshipsProvider.showForm({
        type: 'newProperty',
        classIri: classIri ?? '',
        className: classLabel ?? '',
        classes,
      });
    }),

    vscode.commands.registerCommand('kgExplorer.commitNewProperty', async (name: string, label: string, kind: string, range: string, classIri: string) => {
      try {
        // find the ontology file for this class
        const loc = store.getDefinitionLocation(classIri);
        let targetFile: vscode.Uri | undefined;
        if (loc) { targetFile = loc.uri; } else {
          const files = await vscode.workspace.findFiles('**/*.ttl', '**/node_modules/**', 10);
          if (files.length > 0) { targetFile = files[0]; }
        }
        if (!targetFile) { vscode.window.showWarningMessage('No TTL file found'); return; }

        const doc = await vscode.workspace.openTextDocument(targetFile);
        const text = doc.getText();

        // determine the namespace prefix for this property
        const prefixes = store.getPrefixes();
        let propPrefix = '';
        let propNs = '';
        for (const [p, ns] of prefixes) {
          if (classIri.startsWith(ns) && p) { propPrefix = p; propNs = ns; break; }
        }
        const propCompact = propPrefix ? `${propPrefix}:${name}` : name;
        const domainCompact = store.compact(classIri);

        // determine range compact form
        let rangeCompact = range;
        if (kind === 'object' && range) {
          rangeCompact = store.compact(range);
        }

        // check if any prefixes used in the new block are missing from the file
        const wsEdit = new vscode.WorkspaceEdit();
        const neededPrefixes = [domainCompact, rangeCompact, propCompact].filter(Boolean);
        for (const compact of neededPrefixes) {
          const colonIdx = compact.indexOf(':');
          if (colonIdx > 0) {
            const pfx = compact.substring(0, colonIdx);
            if (pfx !== 'owl' && pfx !== 'rdfs' && pfx !== 'rdf' && pfx !== 'xsd') {
              const pfxDecl = `@prefix ${pfx}:`;
              if (!text.includes(pfxDecl)) {
                const ns = store.getPrefixes().get(pfx);
                if (ns) {
                  const lastPrefixLine = text.split('\n').findIndex((l: string, i: number, arr: string[]) =>
                    i > 0 && !l.startsWith('@prefix') && arr[i - 1].startsWith('@prefix'));
                  const insertLine = lastPrefixLine > 0 ? lastPrefixLine : 0;
                  wsEdit.insert(targetFile!, new vscode.Position(insertLine, 0), `@prefix ${pfx}: <${ns}> .\n`);
                }
              }
            }
          }
        }

        const propType = kind === 'object' ? 'owl:ObjectProperty' : 'owl:DatatypeProperty';
        let newBlock = `\n${propCompact} a ${propType} ;\n    rdfs:label "${label}" ;\n    rdfs:domain ${domainCompact}`;
        if (rangeCompact) { newBlock += ` ;\n    rdfs:range ${rangeCompact}`; }
        newBlock += ` .\n`;

        const lastLine = doc.lineCount - 1;
        wsEdit.insert(targetFile, new vscode.Position(lastLine, doc.lineAt(lastLine).text.length), newBlock);
        const ok = await vscode.workspace.applyEdit(wsEdit);
        if (ok) {
          await doc.save();
          await loadAllTtl();
          relationshipsProvider.select(classIri, true);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to add property: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.addImport', async (ns: string) => { try {
      // find other ontologies in the workspace
      const ontRows = store.query(`
        SELECT ?ont ?label WHERE {
          ?ont a owl:Ontology .
          OPTIONAL { ?ont rdfs:label ?label }
        }
      `);
      const items = ontRows
        .filter(r => r.get('ont')!.value !== ns)
        .map(r => ({
          label: r.get('label')?.value ?? store.localName(r.get('ont')!.value),
          detail: store.compact(r.get('ont')!.value),
          iri: r.get('ont')!.value,
        }));

      if (items.length === 0) {
        vscode.window.showWarningMessage('No other ontologies found in the workspace');
        return;
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select ontology to import...',
        matchOnDetail: true,
      });
      if (!picked) { return; }

      // find the ontology file
      const files = await vscode.workspace.findFiles('**/*.ttl', '**/node_modules/**', 50);
      let targetFile: vscode.Uri | undefined;
      for (const f of files) {
        const content = (await vscode.workspace.fs.readFile(f)).toString();
        if (content.includes(ns) && (content.includes('owl:Ontology') || content.includes('a owl:Ontology'))) {
          targetFile = f;
          break;
        }
      }
      if (!targetFile) {
        vscode.window.showWarningMessage('Could not find ontology file');
        return;
      }

      // find the ontology declaration and add owl:imports
      const doc = await vscode.workspace.openTextDocument(targetFile);
      const text = doc.getText();
      const lines = text.split('\n');

      // find the line with "a owl:Ontology" and the block end
      // skip dots inside triple-quoted strings
      let ontLine = -1;
      let blockEnd = -1;
      let inTripleQuote = false;
      for (let i = 0; i < lines.length; i++) {
        const tripleQuotes = (lines[i].match(/"""/g) || []).length;
        if (tripleQuotes % 2 !== 0) { inTripleQuote = !inTripleQuote; }
        if (lines[i].includes('owl:Ontology')) { ontLine = i; }
        if (ontLine >= 0 && !inTripleQuote && lines[i].trimEnd().endsWith('.')) { blockEnd = i; break; }
      }

      if (ontLine < 0 || blockEnd < 0) {
        vscode.window.showWarningMessage('Could not find ontology declaration');
        return;
      }

      // check if already imported (check both full IRI and compact form)
      const importCompactCheck = store.compact(picked.iri);
      if (text.includes('owl:imports') && (text.includes(importCompactCheck) || text.includes(picked.iri) || text.includes(`<${picked.iri}>`))) {
        vscode.window.showInformationMessage(`${picked.label} is already imported`);
        return;
      }

      // also add prefix if needed
      let importCompact = store.compact(picked.iri);
      // if compact returns the full IRI, wrap in angle brackets
      if (importCompact === picked.iri || importCompact.startsWith('http')) {
        importCompact = `<${picked.iri}>`;
      }
      const importPrefix = importCompact.includes(':') && !importCompact.startsWith('<') ? importCompact.split(':')[0] : '';
      let prefixLine = '';
      if (importPrefix && !text.includes(`@prefix ${importPrefix}:`)) {
        prefixLine = `@prefix ${importPrefix}: <${picked.iri}> .\n`;
      }

      const wsEdit = new vscode.WorkspaceEdit();

      // add prefix at top if needed
      if (prefixLine) {
        const lastPrefixLine = lines.findIndex((l, i) => i > 0 && !l.startsWith('@prefix') && lines[i - 1].startsWith('@prefix'));
        if (lastPrefixLine > 0) {
          wsEdit.insert(targetFile, new vscode.Position(lastPrefixLine, 0), prefixLine);
        }
      }

      // add owl:imports before the closing dot
      const lastLine = lines[blockEnd];
      const dotPos = lastLine.lastIndexOf('.');
      const before = lastLine.substring(0, dotPos).trimEnd();
      wsEdit.replace(targetFile,
        new vscode.Range(blockEnd, 0, blockEnd, lastLine.length),
        before + ` ;\n    owl:imports ${importCompact} .`
      );

      const ok = await vscode.workspace.applyEdit(wsEdit);
      if (ok) {
        await doc.save();
        await loadAllTtl();
        const nsLabel = store.getLabel(ns) ?? store.localName(ns);
        relationshipsProvider.selectNamespace(ns, nsLabel);
        vscode.window.showInformationMessage(`Imported ${picked.label}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      vscode.window.showErrorMessage(`Failed to add import: ${msg}`);
    } }),

    vscode.commands.registerCommand('kgExplorer.removeImport', async (ns: string, importIri: string) => {
      try {
        const files = await vscode.workspace.findFiles('**/*.ttl', '**/node_modules/**', 50);
        let targetFile: vscode.Uri | undefined;
        for (const f of files) {
          const content = (await vscode.workspace.fs.readFile(f)).toString();
          if (content.includes(ns) && content.includes('owl:Ontology')) {
            targetFile = f; break;
          }
        }
        if (!targetFile) { return; }

        const doc = await vscode.workspace.openTextDocument(targetFile);
        const lines = doc.getText().split('\n');
        const importCompact = store.compact(importIri);

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('owl:imports') && (lines[i].includes(importCompact) || lines[i].includes(importIri))) {
            const wsEdit = new vscode.WorkspaceEdit();
            const lineEndsWithDot = lines[i].trimEnd().endsWith('.');
            wsEdit.delete(targetFile, new vscode.Range(i, 0, i + 1, 0));
            // if this was the last property (ended with .), fix the previous line's ; to .
            if (lineEndsWithDot && i > 0) {
              const prevLine = lines[i - 1];
              const trimmed = prevLine.trimEnd();
              if (trimmed.endsWith(';')) {
                wsEdit.replace(targetFile,
                  new vscode.Range(i - 1, trimmed.length - 1, i - 1, trimmed.length),
                  '.'
                );
              }
            }
            const ok = await vscode.workspace.applyEdit(wsEdit);
            if (ok) {
              await doc.save();
              await loadAllTtl();
              const nsLabel = store.getLabel(ns) ?? store.localName(ns);
              relationshipsProvider.selectNamespace(ns, nsLabel);
            }
            return;
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`Failed to remove import: ${msg}`);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.renameEntity', async (arg: unknown) => {
      const iri = extractIri(arg);
      if (!iri) { return; }
      vscode.window.showInformationMessage('Rename — coming in Phase 5');
    }),

    vscode.commands.registerCommand('kgExplorer.deleteOntology', async (arg: unknown) => {
      let ns = '';
      if (typeof arg === 'object' && arg !== null && 'kind' in arg && (arg as any).kind === 'namespace') {
        ns = (arg as any).ns;
      }
      if (!ns) { return; }
      const ontIri = ns.endsWith('#') ? ns.slice(0, -1) : ns.endsWith('/') ? ns.slice(0, -1) : ns;
      const label = store.getLabel(ns) || store.getLabel(ontIri) || store.localName(ns) || ns;
      const answer = await vscode.window.showWarningMessage(
        `Delete ontology "${label}" and its declaration block? Classes and instances will NOT be deleted.`,
        { modal: true }, 'Delete'
      );
      if (answer !== 'Delete') { return; }
      let ok = await editor.deleteSubjectBlock(ns);
      if (!ok) { ok = await editor.deleteSubjectBlock(ontIri); }
      if (!ok) { ok = await editor.deleteSubjectBlock(ns + '>'); }
      if (ok) {
        await loadAllTtl();
        vscode.window.showInformationMessage(`Deleted ontology: ${label}`);
      } else {
        vscode.window.showWarningMessage(`Could not find ontology declaration for "${label}".`);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.deleteClass', async (arg: unknown) => {
      const iri = extractIri(arg);
      if (!iri) { return; }
      const label = store.getLabel(iri) || store.localName(iri) || iri;
      const answer = await vscode.window.showWarningMessage(
        `Delete class "${label}" and all its triples? Instances of this class will NOT be deleted.`,
        { modal: true }, 'Delete'
      );
      if (answer !== 'Delete') { return; }
      const ok = await editor.deleteSubjectBlock(iri);
      if (ok) {
        await loadAllTtl();
        vscode.window.showInformationMessage(`Deleted class: ${label}`);
      } else {
        vscode.window.showWarningMessage(`Could not find "${label}" in any TTL file.`);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.deleteEntity', async (arg: unknown) => {
      const iri = extractIri(arg);
      if (!iri) { return; }
      const label = store.getLabel(iri) || store.localName(iri) || iri;
      const answer = await vscode.window.showWarningMessage(
        `Delete "${label}" and all its triples?`,
        { modal: true }, 'Delete'
      );
      if (answer !== 'Delete') { return; }
      const ok = await editor.deleteSubjectBlock(iri);
      if (ok) {
        await loadAllTtl();
        vscode.window.showInformationMessage(`Deleted: ${label}`);
      } else {
        vscode.window.showWarningMessage(`Could not find "${label}" in any TTL file.`);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.editValue', async (subject: string, predicate: string, oldValue: string, newValue: string) => {
      const delOk = await editor.deleteTriple(subject, predicate, oldValue);
      if (delOk) {
        const addOk = await editor.addTriple(subject, predicate, newValue, true);
        if (addOk) {
          await loadAllTtl();
          relationshipsProvider.select(subject, false);
        }
      }
    }),

    vscode.commands.registerCommand('kgExplorer.copyIri', async (arg: unknown) => {
      const iri = extractIri(arg);
      if (!iri) { return; }
      await vscode.env.clipboard.writeText(iri);
      vscode.window.showInformationMessage(`Copied: ${store.compact(iri)}`);
    }),

    vscode.commands.registerCommand('kgExplorer.sparql', () => {
      sparqlPanel.show();
    }),

    vscode.commands.registerCommand('kgExplorer.newInstance', async (arg: unknown) => {
      let classIri: string | undefined;
      let classLabel: string | undefined;
      if (typeof arg === 'object' && arg !== null && 'kind' in arg && (arg as any).kind === 'class') {
        classIri = (arg as any).data?.iri;
        classLabel = (arg as any).data?.label;
      } else {
        classIri = extractIri(arg);
        classLabel = classIri ? store.localName(classIri) : undefined;
      }
      if (!classIri) { return; }
      relationshipsProvider.showForm({ type: 'newInstance', classIri, className: classLabel ?? 'Instance' });
    }),

    vscode.commands.registerCommand('kgExplorer.commitNewInstance', async (localName: string, label: string, classIri: string) => {
      const loc = store.getDefinitionLocation(classIri);
      let targetFile: vscode.Uri | undefined;
      if (loc) { targetFile = loc.uri; } else {
        const ttlFiles = await vscode.workspace.findFiles('**/*.ttl', '**/node_modules/**', 10);
        if (ttlFiles.length > 0) { targetFile = ttlFiles[0]; }
      }
      if (!targetFile) { vscode.window.showWarningMessage('No TTL file found'); return; }

      const doc = await vscode.workspace.openTextDocument(targetFile);
      const text = doc.getText();
      const defaultPrefixMatch = text.match(/@prefix\s+:\s*<([^>]+)>/);
      const instanceNs = defaultPrefixMatch ? defaultPrefixMatch[1] : '';
      if (!instanceNs) {
        vscode.window.showWarningMessage('No default prefix (@prefix : <...>) found in target file. Cannot create instance.');
        return;
      }
      const instanceIri = instanceNs + localName;
      const compacted = store.compact(instanceIri);
      const subjCompact = compacted.includes(':') ? compacted : `:${localName}`;
      const typeCompact = store.compact(classIri);

      const newBlock = `\n${subjCompact} a ${typeCompact} ;\n    rdfs:label "${label}" .\n`;
      const wsEdit = new vscode.WorkspaceEdit();
      const lastLine = doc.lineCount - 1;
      wsEdit.insert(targetFile, new vscode.Position(lastLine, doc.lineAt(lastLine).text.length), newBlock);
      const ok = await vscode.workspace.applyEdit(wsEdit);
      if (ok) {
        await doc.save();
        await loadAllTtl();
        relationshipsProvider.select(instanceIri, false);
        setTimeout(() => revealInOntology(instanceIri), 200);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.newClass', async (arg: unknown) => {
      let ns = '';
      let prefix = '';
      if (typeof arg === 'object' && arg !== null && 'kind' in arg && (arg as any).kind === 'namespace') {
        ns = (arg as any).ns;
        prefix = (arg as any).prefix;
      }
      relationshipsProvider.showForm({ type: 'newClass', ns, prefix });
    }),

    vscode.commands.registerCommand('kgExplorer.commitNewClass', async (name: string, label: string, comment: string, _ns: string, superclass?: string) => {
      // find the selected namespace or default
      const currentNs = relationshipsProvider['selectedIri'] ?? '';
      const ns = currentNs.endsWith('#') || currentNs.endsWith('/') ? currentNs : '';

      let targetFile: vscode.Uri | undefined;
      if (ns) {
        const files = await vscode.workspace.findFiles('**/*.ttl', '**/node_modules/**', 50);
        for (const f of files) {
          const content = (await vscode.workspace.fs.readFile(f)).toString();
          if (!content.includes(ns)) { continue; }
          if (f.fsPath.includes('shapes') || f.fsPath.includes('shacl')) { continue; }
          if (content.includes('owl:Ontology') || content.includes('owl:Class')) {
            targetFile = f; break;
          }
        }
      }
      if (!targetFile) {
        const ttlFiles = await vscode.workspace.findFiles('**/*.ttl', '**/node_modules/**', 10);
        if (ttlFiles.length > 0) { targetFile = ttlFiles[0]; }
      }
      if (!targetFile) { vscode.window.showWarningMessage('No TTL file found'); return; }

      const classIri = ns + name;
      const classCompact = store.compact(classIri) || name;

      let newBlock = `\n${classCompact} a owl:Class ;\n`;
      if (superclass) {
        const superCompact = store.compact(superclass);
        const safeSuperCompact = superCompact.includes(':') ? superCompact : `<${superclass}>`;
        newBlock += `    rdfs:subClassOf ${safeSuperCompact} ;\n`;
      }
      newBlock += `    rdfs:label "${label}"`;
      if (comment) { newBlock += ` ;\n    rdfs:comment "${comment}"`; }
      newBlock += ` .\n`;

      const doc = await vscode.workspace.openTextDocument(targetFile);
      const wsEdit = new vscode.WorkspaceEdit();
      const lastLine = doc.lineCount - 1;
      wsEdit.insert(targetFile, new vscode.Position(lastLine, doc.lineAt(lastLine).text.length), newBlock);
      const ok = await vscode.workspace.applyEdit(wsEdit);
      if (ok) {
        await doc.save();
        await loadAllTtl();
        relationshipsProvider.select(classIri, true);
        setTimeout(() => revealInOntology(classIri), 200);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.prepareAddRelationship', async (subject: string) => {
      const typeRow = store.query(`SELECT ?t WHERE { <${subject}> a ?t . ?t a owl:Class . } LIMIT 1`);
      const classIri = typeRow[0]?.get('t')?.value;

      // Walk superclass chain for inherited properties
      const superclasses: string[] = [];
      if (classIri) {
        const visited = new Set<string>([classIri]);
        const queue = [classIri];
        while (queue.length > 0) {
          const current = queue.shift()!;
          const parents = store.query(`SELECT ?parent WHERE { <${current}> rdfs:subClassOf ?parent . ?parent a owl:Class . FILTER(?parent != <${current}>) }`);
          for (const r of parents) {
            const p = r.get('parent')!.value;
            if (!visited.has(p)) { visited.add(p); superclasses.push(p); queue.push(p); }
          }
        }
      }
      const domainFilter = [classIri, ...superclasses].filter(Boolean).map(c => `{ ?p rdfs:domain <${c}> . }`).join(' UNION ');

      const predRows = classIri
        ? store.query(`
            SELECT DISTINCT ?p ?pLabel WHERE {
              { ?s a <${classIri}> . ?s ?p ?o . }
              UNION
              ${domainFilter}
              FILTER(?p != rdf:type && ?p != rdfs:subClassOf && ?p != owl:imports
                     && ?p != rdfs:subPropertyOf && ?p != rdfs:domain && ?p != rdfs:range)
              OPTIONAL { ?p rdfs:label ?pLabel }
            } ORDER BY ?pLabel LIMIT 100
          `)
        : store.query(`
            SELECT DISTINCT ?p ?pLabel WHERE {
              <${subject}> ?p ?o .
              FILTER(?p != rdf:type && ?p != rdfs:subClassOf && ?p != owl:imports)
              OPTIONAL { ?p rdfs:label ?pLabel }
            } ORDER BY ?pLabel LIMIT 50
          `);

      const rangeEntitiesCache = new Map<string, {iri: string, label: string}[]>();
      const predicates = predRows.map(r => {
        const iri = r.get('p')!.value;
        const label = r.get('pLabel')?.value ?? store.localName(iri);
        const rangeRows = store.query(`SELECT ?range WHERE { <${iri}> rdfs:range ?range } LIMIT 1`);
        const range = rangeRows[0]?.get('range')?.value;
        const rangeName = range ? store.localName(range) : '';
        const rangeIri = range ?? '';
        if (range && !rangeEntitiesCache.has(range)) {
          const entRows = store.query(`SELECT ?inst ?label WHERE { ?inst a <${range}> . OPTIONAL { ?inst rdfs:label ?label } FILTER(isIRI(?inst)) } ORDER BY ?label LIMIT 200`);
          rangeEntitiesCache.set(range, entRows.map(e => ({
            iri: e.get('inst')!.value,
            label: e.get('label')?.value ?? store.localName(e.get('inst')!.value),
          })));
        }
        return { iri, label, range: rangeName, rangeIri };
      });

      const rangeEntities: Record<string, {iri: string, label: string}[]> = {};
      for (const [k, v] of rangeEntitiesCache) { rangeEntities[k] = v; }

      relationshipsProvider.showForm({ type: 'addRelationship', subject, predicates, rangeEntities, hasRemote: store.getRemoteEndpoints().size > 0 });
    }),

    vscode.commands.registerCommand('kgExplorer.prepareAddParam', async (subject: string) => {
      const typeRow = store.query(`SELECT ?t WHERE { <${subject}> a ?t . ?t a owl:Class . } LIMIT 1`);
      const classIri = typeRow[0]?.get('t')?.value;

      const allClasses: string[] = classIri ? [classIri] : [];
      if (classIri) {
        const visited = new Set<string>([classIri]);
        const queue = [classIri];
        while (queue.length > 0) {
          const current = queue.shift()!;
          const parents = store.query(`SELECT ?parent WHERE { <${current}> rdfs:subClassOf ?parent . ?parent a owl:Class . FILTER(?parent != <${current}>) }`);
          for (const r of parents) {
            const p = r.get('parent')!.value;
            if (!visited.has(p)) { visited.add(p); allClasses.push(p); queue.push(p); }
          }
        }
      }

      const domainFilter = allClasses.map(c => `{ ?p rdfs:domain <${c}> . }`).join(' UNION ');
      const predRows = store.query(`
        SELECT DISTINCT ?p ?pLabel WHERE {
          ?p a owl:DatatypeProperty .
          ${domainFilter || '{ ?p rdfs:domain ?any }'}
          OPTIONAL { ?p rdfs:label ?pLabel }
        } ORDER BY ?pLabel LIMIT 50
      `);

      const predicates = predRows.map(r => ({
        iri: r.get('p')!.value,
        label: r.get('pLabel')?.value ?? store.localName(r.get('p')!.value),
      }));

      relationshipsProvider.showForm({ type: 'addParam', subject, predicates });
    }),

    vscode.commands.registerCommand('kgExplorer.commitAddParam', async (subject: string, predicate: string, value: string) => {
      const ok = await editor.addTriple(subject, predicate, value, true);
      if (ok) { await loadAllTtl(); relationshipsProvider.select(subject, false); }
    }),

    vscode.commands.registerCommand('kgExplorer.loadRemoteEntities', async (rangeIri: string, rangeName: string) => {
      try {
        const results = await store.getRemoteInstances(rangeIri);
        relationshipsProvider.showForm({ type: 'arRemoteEntitiesLoaded', results: results.map(r => ({ iri: r.iri, label: r.label })), rangeName });
      } catch {
        relationshipsProvider.showForm({ type: 'arRemoteEntitiesLoaded', results: [], rangeName });
      }
    }),

    vscode.commands.registerCommand('kgExplorer.prepareEditRelationship', async (subject: string, predicate: string, oldValue: string, oldLabel: string, dir: string = 'out') => {
      const lookupProp = dir === 'in' ? 'rdfs:domain' : 'rdfs:range';
      const typeRows = store.query(`SELECT ?type WHERE { <${predicate}> ${lookupProp} ?type }`);
      const genericIris = new Set([
        'http://www.w3.org/2000/01/rdf-schema#Resource', 'http://www.w3.org/2000/01/rdf-schema#Class',
        'http://www.w3.org/2002/07/owl#Thing', 'http://www.w3.org/2002/07/owl#Class',
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property', 'http://www.w3.org/2000/01/rdf-schema#Literal',
      ]);
      const stdNs = ['http://www.w3.org/2001/XMLSchema#', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        'http://www.w3.org/2000/01/rdf-schema#', 'http://www.w3.org/2002/07/owl#'];
      let targetType = typeRows.map(r => r.get('type')!.value).find(t => !genericIris.has(t) && !stdNs.some(ns => t.startsWith(ns)));
      if (!targetType) {
        const superPropRows = store.query(`SELECT ?type WHERE { <${predicate}> rdfs:subPropertyOf ?sp . ?sp ${lookupProp} ?type }`);
        targetType = superPropRows.map(r => r.get('type')!.value).find(t => !genericIris.has(t) && !stdNs.some(ns => t.startsWith(ns)));
      }
      if (!targetType) { targetType = typeRows[0]?.get('type')?.value ?? ''; }

      // Fetch local instances — include subclass instances
      let localRows: ReturnType<typeof store.query> = [];
      if (targetType) {
        const subclasses = store.query(`SELECT ?sub WHERE { ?sub rdfs:subClassOf <${targetType}> . ?sub a owl:Class . FILTER(?sub != <${targetType}>) }`);
        const types = [targetType, ...subclasses.map(r => r.get('sub')!.value)];
        const typeUnion = types.map(t => `{ ?inst a <${t}> }`).join(' UNION ');
        localRows = store.query(`SELECT ?inst ?label WHERE { ${typeUnion} . OPTIONAL { ?inst rdfs:label ?label } FILTER(isIRI(?inst)) } ORDER BY ?label LIMIT 500`);
      }
      const localOptions = localRows.map(r => {
        let label = r.get('label')?.value ?? store.localName(r.get('inst')!.value);
        try { label = decodeURIComponent(label); } catch {}
        return { iri: r.get('inst')!.value, label };
      });

      // Also fetch remote instances if no local ones
      let remoteOptions: { iri: string; label: string }[] = [];
      if (localOptions.length === 0 && store.getRemoteEndpoints().size > 0 && targetType) {
        try {
          remoteOptions = await store.getRemoteInstances(targetType);
        } catch {}
      }

      relationshipsProvider.showForm({
        type: 'editRelationship', subject, predicate, oldValue, oldLabel, targetType,
        localOptions, remoteOptions, hasRemote: store.getRemoteEndpoints().size > 0,
      });
    }),

    vscode.commands.registerCommand('kgExplorer.searchForEditForm', async (query: string, targetType: string) => {
      const results: { iri: string; label: string }[] = [];
      if (targetType) {
        const rows = store.query(`SELECT ?inst ?label WHERE { ?inst a <${targetType}> . OPTIONAL { ?inst rdfs:label ?label } FILTER(isIRI(?inst)) FILTER(CONTAINS(LCASE(COALESCE(STR(?label), STR(?inst))), "${query.toLowerCase()}")) } LIMIT 20`);
        for (const r of rows) {
          let label = r.get('label')?.value ?? store.localName(r.get('inst')!.value);
          try { label = decodeURIComponent(label); } catch {}
          results.push({ iri: r.get('inst')!.value, label });
        }
      }
      if (store.getRemoteEndpoints().size > 0 && targetType) {
        try {
          const remote = await store.searchRemoteInstances(targetType, query);
          const seen = new Set(results.map(r => r.iri));
          for (const r of remote) { if (!seen.has(r.iri)) { results.push({ iri: r.iri, label: r.label }); } }
        } catch {}
      }
      relationshipsProvider.showForm({ type: 'editRelSearchResults', results });
    }),

    vscode.commands.registerCommand('kgExplorer.commitEditRelationship', async (subject: string, predicate: string, oldValue: string, newValue: string, oldLabel: string) => {
      let delOk = await editor.deleteTriple(subject, predicate, oldValue, oldLabel);
      if (!delOk) {
        try { const d = decodeURIComponent(oldValue); if (d !== oldValue) { delOk = await editor.deleteTriple(subject, predicate, d, oldLabel); } } catch {}
      }
      const addOk = await editor.addTriple(subject, predicate, newValue, false);
      if (addOk) { await loadAllTtl(); relationshipsProvider.select(subject, false); }
      else { vscode.window.showWarningMessage('Failed to update relationship'); }
    }),

    vscode.commands.registerCommand('kgExplorer.commitAddRel', async (subject: string, predicate: string, value: string, isObject: boolean) => {
      const ok = await editor.addTriple(subject, predicate, value, !isObject);
      if (ok) {
        await loadAllTtl();
        relationshipsProvider.select(subject, false);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.pickEntityForForm', async (subject: string, predicate: string, rangeName: string) => {
      // look up the actual range IRI
      const rangeRows = store.query(`SELECT ?range WHERE { <${predicate}> rdfs:range ?range } LIMIT 1`);
      let range = rangeRows[0]?.get('range')?.value;
      if (!range) {
        const invRows = store.query(`SELECT ?domain WHERE { ?inv owl:inverseOf <${predicate}> . ?inv rdfs:domain ?domain . } LIMIT 1`);
        range = invRows[0]?.get('domain')?.value;
      }

      const entityRows = range
        ? store.query(`SELECT ?inst ?label WHERE { ?inst a <${range}> . OPTIONAL { ?inst rdfs:label ?label } FILTER(isIRI(?inst)) } ORDER BY ?label LIMIT 200`)
        : store.query(`SELECT ?inst ?label WHERE { ?inst rdfs:label ?label . FILTER(isIRI(?inst)) } ORDER BY ?label LIMIT 200`);

      const items = entityRows.map(r => ({
        label: r.get('label')?.value ?? store.localName(r.get('inst')!.value),
        detail: store.compact(r.get('inst')!.value),
        iri: r.get('inst')!.value,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: range ? `Select ${store.localName(range)}...` : 'Select entity...',
        matchOnDetail: true,
      });
      if (picked) {
        // send the picked entity back to the form
        relationshipsProvider.showForm({ type: 'setFormValue', value: picked.iri, label: picked.label });
      }
    }),

    vscode.commands.registerCommand('kgExplorer.showGraph', (arg: unknown) => {
      const iri = extractIri(arg);
      if (iri) { graphPanel.show(iri); }
    }),

    vscode.commands.registerCommand('kgExplorer.deleteTriple', async (subject: string, predicate: string, object: string, label?: string) => {
      console.log(`[KG] deleteTriple: subj=${subject}, pred=${predicate}, obj=${object}, label=${label}`);
      const ok = await editor.deleteTriple(subject, predicate, object, label);
      if (ok) {
        await loadAllTtl();
        try { relationshipsProvider.select(subject, false); } catch { /* */ }
      } else {
        vscode.window.showWarningMessage(`Could not find triple to delete`);
      }
    }),

    vscode.commands.registerCommand('kgExplorer.addProperty', async (subject: string, predicate: string, range: string, isObject: boolean) => {
      if (isObject) {
        const rows = range
          ? store.query(`SELECT ?inst ?label WHERE {
              ?inst a <${range}> .
              OPTIONAL { ?inst rdfs:label ?label }
              FILTER(isIRI(?inst))
            } ORDER BY ?label LIMIT 200`)
          : store.query(`SELECT DISTINCT ?inst ?label WHERE {
              ?inst rdfs:label ?label .
              FILTER(isIRI(?inst))
            } ORDER BY ?label LIMIT 200`);
        const items = rows.map(row => ({
          label: row.get('label')?.value ?? store.localName(row.get('inst')!.value),
          detail: store.compact(row.get('inst')!.value),
          iri: row.get('inst')!.value,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: range ? `Select ${store.localName(range)}...` : 'Select entity...',
          matchOnDetail: true,
        });
        if (!picked) { return; }
        const ok = await editor.addTriple(subject, predicate, picked.iri, false);
        if (ok) {
          await loadAllTtl();
          relationshipsProvider.select(subject, false);
        }
      } else {
        const value = await vscode.window.showInputBox({
          prompt: `Enter value for ${store.localName(predicate)}`,
          placeHolder: range ? `Expected: ${store.localName(range)}` : 'Enter value...',
        });
        if (value === undefined) { return; }
        const ok = await editor.addTriple(subject, predicate, value, true);
        if (ok) {
          await loadAllTtl();
          relationshipsProvider.select(subject, false);
        }
      }
    }),

    vscode.commands.registerCommand('kgExplorer.addRelationship', async (subject: string) => {
      // scope predicates to those used by the same type, plus those with matching domain
      const typeRow = store.query(`SELECT ?t WHERE { <${subject}> a ?t . ?t a owl:Class . } LIMIT 1`);
      const classIri = typeRow[0]?.get('t')?.value;

      const predRows = classIri
        ? store.query(`
            SELECT DISTINCT ?p ?pLabel WHERE {
              { ?s a <${classIri}> . ?s ?p ?o . }
              UNION
              { ?p rdfs:domain <${classIri}> . }
              FILTER(?p != rdf:type && ?p != rdfs:subClassOf && ?p != owl:imports
                     && ?p != rdfs:subPropertyOf && ?p != rdfs:domain && ?p != rdfs:range)
              OPTIONAL { ?p rdfs:label ?pLabel }
            } ORDER BY ?pLabel LIMIT 100
          `)
        : store.query(`
            SELECT DISTINCT ?p ?pLabel WHERE {
              <${subject}> ?p ?o .
              FILTER(?p != rdf:type && ?p != rdfs:subClassOf && ?p != owl:imports)
              OPTIONAL { ?p rdfs:label ?pLabel }
            } ORDER BY ?pLabel LIMIT 100
          `);
      const predItems = predRows.map(r => {
        const iri = r.get('p')!.value;
        return {
          label: r.get('pLabel')?.value ?? store.localName(iri),
          detail: store.compact(iri),
          iri,
        };
      });

      const pickedPred = await vscode.window.showQuickPick(predItems, {
        placeHolder: 'Select property...',
        matchOnDetail: true,
      });
      if (!pickedPred) { return; }

      // check for declared range, inverse domain, or infer from usage
      let range: string | undefined;
      const rangeRows = store.query(`
        SELECT ?range WHERE { <${pickedPred.iri}> rdfs:range ?range } LIMIT 1
      `);
      range = rangeRows[0]?.get('range')?.value;

      if (!range) {
        const inverseRows = store.query(`
          SELECT ?domain WHERE {
            ?inv owl:inverseOf <${pickedPred.iri}> .
            ?inv rdfs:domain ?domain .
          } LIMIT 1
        `);
        range = inverseRows[0]?.get('domain')?.value;
      }

      if (!range) {
        const usageRows = store.query(`
          SELECT ?type (COUNT(?o) AS ?n) WHERE {
            ?s <${pickedPred.iri}> ?o .
            ?o a ?type . ?type a owl:Class .
          } GROUP BY ?type ORDER BY DESC(?n) LIMIT 1
        `);
        range = usageRows[0]?.get('type')?.value;
      }

      // check if range is a datatype (xsd:*)
      const isDatatype = range && range.startsWith('http://www.w3.org/2001/XMLSchema#');

      if (isDatatype) {
        const value = await vscode.window.showInputBox({
          prompt: `Enter ${store.localName(range!)} value for ${pickedPred.label}`,
        });
        if (value === undefined) { return; }
        const ok = await editor.addTriple(subject, pickedPred.iri, value, true);
        if (ok) { await loadAllTtl(); relationshipsProvider.select(subject, false); }
        return;
      }

      // show entity picker with lazy remote search
      const entityRows = range
        ? store.query(`
            SELECT ?inst ?label WHERE {
              ?inst a <${range}> .
              OPTIONAL { ?inst rdfs:label ?label }
              FILTER(isIRI(?inst))
            } ORDER BY ?label LIMIT 200`)
        : store.query(`
            SELECT ?inst ?label WHERE {
              ?inst rdfs:label ?label .
              FILTER(isIRI(?inst))
            } ORDER BY ?label LIMIT 200`);

      const localItems: (vscode.QuickPickItem & { iri: string })[] = entityRows.map(r => {
        let label = r.get('label')?.value ?? store.localName(r.get('inst')!.value);
        try { label = decodeURIComponent(label); } catch { /* */ }
        return { label, detail: store.compact(r.get('inst')!.value), iri: r.get('inst')!.value };
      });

      const hasRemote = range && store.getRemoteEndpoints().size > 0;
      const rangeName = range ? store.localName(range) : 'entity';

      const pickedEntity = await new Promise<{ iri: string } | undefined>(resolve => {
        const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { iri: string }>();
        qp.placeholder = hasRemote
          ? `Search ${rangeName} (local + remote)...`
          : `Select ${rangeName}...`;
        qp.items = localItems;
        qp.matchOnDetail = true;

        let debounce: ReturnType<typeof setTimeout> | undefined;
        let lastQuery = '';

        if (hasRemote) {
          qp.onDidChangeValue(value => {
            if (debounce) { clearTimeout(debounce); }
            if (value.length < 2) {
              qp.items = localItems;
              lastQuery = '';
              return;
            }
            if (value === lastQuery) { return; }
            debounce = setTimeout(async () => {
              lastQuery = value;
              qp.busy = true;
              try {
                const remoteResults = await store.searchRemoteInstances(range!, value);
                const seen = new Set(localItems.map(i => i.iri));
                const remoteItems = remoteResults
                  .filter(r => !seen.has(r.iri))
                  .map(r => ({ label: r.label, detail: `$(globe) remote`, iri: r.iri }));
                const filtered = localItems.filter(i => i.label.toLowerCase().includes(value.toLowerCase()));
                qp.items = [...filtered, ...remoteItems];
              } catch { /* keep local items */ }
              qp.busy = false;
            }, 300);
          });
        }

        let lastActive2: (vscode.QuickPickItem & { iri: string }) | undefined;
        qp.onDidChangeActive(items => { if (items[0]) { lastActive2 = items[0] as any; } });
        qp.onDidAccept(() => {
          const sel = lastActive2 ?? qp.activeItems[0] ?? qp.selectedItems[0];
          qp.dispose();
          resolve(sel as any);
        });
        qp.onDidHide(() => {
          qp.dispose();
          resolve(undefined);
        });
        qp.show();
      });

      if (!pickedEntity) { return; }

      const ok = await editor.addTriple(subject, pickedPred.iri, pickedEntity.iri, false);
      if (ok) { await loadAllTtl(); relationshipsProvider.select(subject, false); }
    }),

    vscode.commands.registerCommand('kgExplorer.addSource', async () => {
      const choice = await vscode.window.showQuickPick([
        { label: '$(add) New Ontology', description: 'Create a new local TTL file', id: 'ontology' },
        { label: '$(globe) Connect SPARQL Endpoint', description: 'Connect to a remote knowledge graph', id: 'endpoint' },
      ], { placeHolder: 'Add source...' });
      if (!choice) { return; }
      if (choice.id === 'ontology') {
        vscode.commands.executeCommand('kgExplorer.newOntology');
      } else {
        vscode.commands.executeCommand('kgExplorer.connectEndpoint');
      }
    }),

    vscode.commands.registerCommand('kgExplorer.refreshSource', async (arg: unknown) => {
      if (typeof arg === 'object' && arg !== null && 'kind' in arg && (arg as any).kind === 'source') {
        const source = arg as any;
        if (source.sourceType === 'local') {
          await loadAllTtl();
          vscode.window.showInformationMessage('Refreshed local files');
        } else if (source.url) {
          try {
            const count = await store.connectEndpoint(source.name, source.url);
            ontologyProvider.refresh();
            vscode.window.showInformationMessage(`Refreshed ${source.name}: ${count.toLocaleString()} triples`);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Refresh failed: ${err.message || err}`);
          }
        }
      } else {
        await loadAllTtl();
      }
    }),

    vscode.commands.registerCommand('kgExplorer.connectEndpoint', async () => {
      const url = await vscode.window.showInputBox({
        prompt: 'SPARQL query endpoint URL',
        placeHolder: 'http://example.org:3330/dataset/query',
        validateInput: v => {
          try { new URL(v); return null; } catch { return 'Invalid URL'; }
        },
      });
      if (!url) { return; }

      const name = await vscode.window.showInputBox({
        prompt: 'Display name for this endpoint',
        placeHolder: 'My Knowledge Graph',
        value: new URL(url).hostname.split('.')[0],
      });
      if (!name) { return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${name}...` },
        async () => {
          try {
            const count = await store.connectEndpoint(name, url);
            // Persist for restart
            const saved = getSavedEndpoints(context);
            if (!saved.some(e => e.url === url)) {
              saved.push({ name, url });
              saveEndpoints(context, saved);
            }
            ontologyProvider.refresh();
            vscode.window.showInformationMessage(`Connected to ${name}: loaded ${count.toLocaleString()} triples`);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to connect: ${err.message || err}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand('kgExplorer.disconnectEndpoint', async (arg: unknown) => {
      let url: string | undefined;
      let name: string | undefined;

      // From inline button on source node
      if (typeof arg === 'object' && arg !== null && 'kind' in arg && (arg as any).kind === 'source') {
        url = (arg as any).url;
        name = (arg as any).name;
      }

      // From quick pick if no source node provided
      if (!url) {
        const remotes = store.getRemoteEndpoints();
        if (remotes.size === 0) {
          vscode.window.showInformationMessage('No remote endpoints connected.');
          return;
        }
        const items = [...remotes.entries()].map(([u, ep]) => ({
          label: ep.name, detail: u, url: u,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select endpoint to disconnect...',
        });
        if (!picked) { return; }
        url = picked.url;
        name = picked.label;
      }

      if (!url) { return; }
      store.disconnectEndpoint(url);
      const saved = getSavedEndpoints(context).filter(e => e.url !== url);
      saveEndpoints(context, saved);
      await loadAllTtl();
      vscode.window.showInformationMessage(`Disconnected: ${name ?? url}`);
    }),

    vscode.languages.registerHoverProvider(turtleSelector, new TurtleHoverProvider(store)),
    vscode.languages.registerDefinitionProvider(turtleSelector, new TurtleDefinitionProvider(store)),
    vscode.languages.registerCompletionItemProvider(turtleSelector, new TurtleCompletionProvider(store), ':'),
    vscode.languages.registerDocumentSymbolProvider(turtleSelector, new TurtleSymbolProvider(store)),

    store,
    ontologyProvider,
    relationshipsProvider,
    sparqlPanel,
    graphPanel,
    diagnostics,
    statusBar,
  );

  const watcher = vscode.workspace.createFileSystemWatcher('**/*.ttl');
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReload = () => {
    if (debounceTimer) { clearTimeout(debounceTimer); }
    debounceTimer = setTimeout(() => loadAllTtl(), 300);
  };
  watcher.onDidChange(scheduleReload);
  watcher.onDidCreate(scheduleReload);
  watcher.onDidDelete(scheduleReload);
  context.subscriptions.push(watcher);

  await loadAllTtl();
  const localCount = store.tripleCount;
  await connectSavedEndpoints(context);
  const totalCount = store.tripleCount;
  if (totalCount > 0) {
    const remoteCount = totalCount - localCount;
    const parts = [];
    if (localCount > 0) { parts.push(`${localCount.toLocaleString()} local`); }
    if (remoteCount > 0) { parts.push(`${remoteCount.toLocaleString()} remote`); }
    vscode.window.showInformationMessage(`KG Explorer: ${parts.join(' + ')} triples`);
  }
}

async function loadAllTtl(): Promise<void> {
  // save remote endpoints before reload
  const remotes = new Map(store.getRemoteEndpoints());

  const files = await vscode.workspace.findFiles('**/*.ttl', '**/node_modules/**');
  if (files.length > 0) {
    await store.load(files);
  }

  // reconnect previously connected remote endpoints
  for (const [url, ep] of remotes) {
    try {
      await store.connectEndpoint(ep.name, url);
    } catch { /* silent — endpoint may be offline */ }
  }
}

async function connectSavedEndpoints(ctx: vscode.ExtensionContext): Promise<void> {
  // 1. From workspaceState (previously connected via globe icon)
  const saved = getSavedEndpoints(ctx);
  for (const ep of saved) {
    if (!store.getRemoteEndpoints().has(ep.url)) {
      try {
        await store.connectEndpoint(ep.name, ep.url);
      } catch { /* silent — endpoint may be offline */ }
    }
  }

  // 2. From settings.json (rdfStudio.sparqlEndpoints)
  const config = vscode.workspace.getConfiguration('rdfStudio');
  const configured = config.get<{ name: string; url: string; dataset?: string }[]>('sparqlEndpoints', []);
  for (const ep of configured) {
    const url = ep.dataset ? `${ep.url.replace(/\/$/, '')}/${ep.dataset}/query` : ep.url;
    if (!store.getRemoteEndpoints().has(url)) {
      try {
        await store.connectEndpoint(ep.name, url);
      } catch { /* silent */ }
    }
  }
}

export function deactivate(): void {}
