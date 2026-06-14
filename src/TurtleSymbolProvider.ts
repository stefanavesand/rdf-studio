import * as vscode from 'vscode';
import { RdfStore } from './store/RdfStore';

export class TurtleSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly store: RdfStore) {}

  provideDocumentSymbols(
    document: vscode.TextDocument,
  ): vscode.DocumentSymbol[] {
    const symbols: vscode.DocumentSymbol[] = [];
    const prefixes = this.store.isLoaded ? this.store.getPrefixes() : new Map<string, string>();

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const text = line.text;

      if (text.startsWith('@prefix')) {
        const m = text.match(/@prefix\s+(\w*)\s*:\s*<([^>]+)>/);
        if (m) {
          const name = m[1] || '(default)';
          const range = line.range;
          symbols.push(new vscode.DocumentSymbol(
            `${name}:`,
            m[2],
            vscode.SymbolKind.Namespace,
            range,
            range,
          ));
        }
        continue;
      }

      if (text.startsWith('#') || text.trim() === '' || text.startsWith(' ') || text.startsWith('\t')) {
        continue;
      }

      const prefixed = text.match(/^(\w*):(\S+)/);
      if (prefixed && !text.startsWith('@')) {
        const prefix = prefixed[1];
        const local = prefixed[2].replace(/\s.*$/, '');
        const ns = prefixes.get(prefix);
        const iri = ns ? ns + local : `${prefix}:${local}`;

        const label = this.store.isLoaded
          ? this.store.getLabel(iri) ?? local
          : local;

        const types = this.store.isLoaded ? this.store.getTypes(iri) : [];
        const kind = this.symbolKindForTypes(types);

        const endLine = this.findSubjectEnd(document, i);
        const fullRange = new vscode.Range(i, 0, endLine, document.lineAt(endLine).text.length);

        symbols.push(new vscode.DocumentSymbol(
          label,
          this.store.isLoaded ? this.store.compact(iri) : `${prefix}:${local}`,
          kind,
          fullRange,
          line.range,
        ));
      }
    }

    return symbols;
  }

  private findSubjectEnd(document: vscode.TextDocument, startLine: number): number {
    for (let i = startLine; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;
      if (text.trimEnd().endsWith('.')) {
        return i;
      }
    }
    return startLine;
  }

  private symbolKindForTypes(types: string[]): vscode.SymbolKind {
    for (const t of types) {
      if (t === 'Class') { return vscode.SymbolKind.Class; }
      if (t === 'ObjectProperty' || t === 'DatatypeProperty') { return vscode.SymbolKind.Property; }
    }
    return vscode.SymbolKind.Variable;
  }
}
