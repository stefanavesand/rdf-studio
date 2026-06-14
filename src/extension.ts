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
      const node = ontologyProvider.findNode(iri);
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

    vscode.commands.registerCommand('kgExplorer.showProperties', (arg: unknown) => {
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
        relationshipsProvider.select(iri, isClass);
        if (!isClass) { revealInOntology(iri); }
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

      // get all classes for the range picker
      const classRows = store.query(`
        SELECT ?cls ?label WHERE {
          ?cls a owl:Class .
          OPTIONAL { ?cls rdfs:label ?label }
        } ORDER BY ?label LIMIT 100
      `);
      const classes = classRows
        .filter(r => !store.localName(r.get('cls')!.value).startsWith('http'))
        .map(r => ({
          iri: r.get('cls')!.value,
          label: r.get('label')?.value ?? store.localName(r.get('cls')!.value),
        }));

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

    vscode.commands.registerCommand('kgExplorer.deleteClass', async (arg: unknown) => {
      const iri = extractIri(arg);
      if (!iri) { return; }
      vscode.window.showInformationMessage('Delete Class — coming in Phase 5');
    }),

    vscode.commands.registerCommand('kgExplorer.deleteEntity', async (arg: unknown) => {
      const iri = extractIri(arg);
      if (!iri) { return; }
      vscode.window.showInformationMessage('Delete Entity — coming in Phase 5');
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
      const instanceIri = instanceNs + localName;
      const subjCompact = store.compact(instanceIri) || `:${localName}`;
      const typeCompact = store.compact(classIri);

      const newBlock = `\n${subjCompact} a ${typeCompact} ;\n    rdfs:label "${label}" .\n`;
      const wsEdit = new vscode.WorkspaceEdit();
      const lastLine = doc.lineCount - 1;
      wsEdit.insert(targetFile, new vscode.Position(lastLine, doc.lineAt(lastLine).text.length), newBlock);
      const ok = await vscode.workspace.applyEdit(wsEdit);
      if (ok) { await doc.save(); await loadAllTtl(); relationshipsProvider.select(instanceIri, false); revealInOntology(instanceIri); }
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

    vscode.commands.registerCommand('kgExplorer.commitNewClass', async (name: string, label: string, comment: string, _ns: string) => {
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

      let newBlock = `\n${classCompact} a owl:Class ;\n    rdfs:label "${label}"`;
      if (comment) { newBlock += ` ;\n    rdfs:comment "${comment}"`; }
      newBlock += ` .\n`;

      const doc = await vscode.workspace.openTextDocument(targetFile);
      const wsEdit = new vscode.WorkspaceEdit();
      const lastLine = doc.lineCount - 1;
      wsEdit.insert(targetFile, new vscode.Position(lastLine, doc.lineAt(lastLine).text.length), newBlock);
      const ok = await vscode.workspace.applyEdit(wsEdit);
      if (ok) { await doc.save(); await loadAllTtl(); relationshipsProvider.select(classIri, true); revealInOntology(classIri); }
    }),

    vscode.commands.registerCommand('kgExplorer.prepareAddRelationship', async (subject: string) => {
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
            } ORDER BY ?pLabel LIMIT 50
          `)
        : store.query(`
            SELECT DISTINCT ?p ?pLabel WHERE {
              <${subject}> ?p ?o .
              FILTER(?p != rdf:type && ?p != rdfs:subClassOf && ?p != owl:imports)
              OPTIONAL { ?p rdfs:label ?pLabel }
            } ORDER BY ?pLabel LIMIT 50
          `);

      const predicates = predRows.map(r => {
        const iri = r.get('p')!.value;
        const label = r.get('pLabel')?.value ?? store.localName(iri);
        // look up range
        const rangeRows = store.query(`SELECT ?range WHERE { <${iri}> rdfs:range ?range } LIMIT 1`);
        const range = rangeRows[0]?.get('range')?.value;
        const rangeName = range ? store.localName(range) : '';
        return { iri, label, range: rangeName };
      });

      relationshipsProvider.showForm({ type: 'addRelationship', subject, predicates });
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

      // show entity picker — filtered by range if available, all labeled entities otherwise
      console.log(`[KG] addRelationship: final range=${range}, isDatatype=${isDatatype}`);
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

      const entityItems = entityRows.map(r => ({
        label: r.get('label')?.value ?? store.localName(r.get('inst')!.value),
        detail: store.compact(r.get('inst')!.value),
        iri: r.get('inst')!.value,
      }));

      if (entityItems.length === 0) {
        vscode.window.showWarningMessage(`No entities found${range ? ' of type ' + store.localName(range) : ''}`);
        return;
      }

      const pickedEntity = await vscode.window.showQuickPick(entityItems, {
        placeHolder: range ? `Select ${store.localName(range)}...` : 'Select entity...',
        matchOnDetail: true,
      });
      if (!pickedEntity) { return; }

      const ok = await editor.addTriple(subject, pickedPred.iri, pickedEntity.iri, false);
      if (ok) { await loadAllTtl(); relationshipsProvider.select(subject, false); }
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
  if (store.tripleCount > 0) {
    vscode.window.showInformationMessage(`KG Explorer: Loaded ${store.tripleCount} triples from workspace`);
  }
}

async function loadAllTtl(): Promise<void> {
  const files = await vscode.workspace.findFiles('**/*.ttl', '**/node_modules/**');
  if (files.length > 0) {
    await store.load(files);
  }
}

export function deactivate(): void {}
