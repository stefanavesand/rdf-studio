import * as vscode from 'vscode';
import { RdfStore } from './store/RdfStore';

export class TurtleCompletionProvider implements vscode.CompletionItemProvider {
  constructor(private readonly store: RdfStore) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.CompletionItem[] {
    if (!this.store.isLoaded) { return []; }

    const linePrefix = document.lineAt(position).text.substring(0, position.character);

    const colonMatch = linePrefix.match(/(\w*):([A-Za-z_][\w.-]*)?$/);
    if (colonMatch) {
      return this.completePrefixed(colonMatch[1], colonMatch[2] ?? '');
    }

    return [];
  }

  private completePrefixed(prefix: string, partial: string): vscode.CompletionItem[] {
    const ns = this.store.getPrefixes().get(prefix);
    if (!ns) { return []; }

    const rows = this.store.query(`
      SELECT DISTINCT ?s ?label ?type WHERE {
        ?s ?_p ?_o .
        FILTER(STRSTARTS(STR(?s), "${ns}"))
        OPTIONAL { ?s rdfs:label ?label }
        OPTIONAL { ?s a ?type }
      } LIMIT 200
    `);

    const seen = new Set<string>();
    const items: vscode.CompletionItem[] = [];

    for (const row of rows) {
      const iri = row.get('s')!.value;
      if (seen.has(iri)) { continue; }
      seen.add(iri);

      const local = iri.slice(ns.length);
      if (partial && !local.toLowerCase().startsWith(partial.toLowerCase())) { continue; }

      const label = row.get('label')?.value;
      const typeIri = row.get('type')?.value;
      const typeLabel = typeIri ? this.store.localName(typeIri) : undefined;

      const item = new vscode.CompletionItem(
        local,
        this.kindForType(typeIri),
      );
      item.detail = label ?? local;
      if (typeLabel) {
        item.documentation = new vscode.MarkdownString(`*${typeLabel}*`);
      }
      item.insertText = local;
      item.sortText = local.toLowerCase();
      items.push(item);
    }

    const propRows = this.store.query(`
      SELECT DISTINCT ?p ?pLabel WHERE {
        ?_s ?p ?_o .
        FILTER(STRSTARTS(STR(?p), "${ns}"))
        OPTIONAL { ?p rdfs:label ?pLabel }
      } LIMIT 100
    `);

    for (const row of propRows) {
      const iri = row.get('p')!.value;
      if (seen.has(iri)) { continue; }
      seen.add(iri);

      const local = iri.slice(ns.length);
      if (partial && !local.toLowerCase().startsWith(partial.toLowerCase())) { continue; }

      const item = new vscode.CompletionItem(
        local,
        vscode.CompletionItemKind.Property,
      );
      item.detail = row.get('pLabel')?.value ?? local;
      item.insertText = local;
      item.sortText = local.toLowerCase();
      items.push(item);
    }

    return items;
  }

  private kindForType(typeIri: string | undefined): vscode.CompletionItemKind {
    if (!typeIri) { return vscode.CompletionItemKind.Value; }
    const local = this.store.localName(typeIri);
    if (local === 'Class') { return vscode.CompletionItemKind.Class; }
    if (local === 'ObjectProperty' || local === 'DatatypeProperty') { return vscode.CompletionItemKind.Property; }
    return vscode.CompletionItemKind.Value;
  }
}
