import * as vscode from 'vscode';
import { RdfStore } from './store/RdfStore';

export class TurtleDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly store: RdfStore) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Location | undefined {
    if (!this.store.isLoaded) { return; }

    const line = document.lineAt(position).text;
    const iri = this.resolveIriAtPosition(line, position.character);
    if (!iri) { return; }

    const loc = this.store.getDefinitionLocation(iri);
    if (!loc) { return; }

    return new vscode.Location(loc.uri, new vscode.Position(loc.line, 0));
  }

  private resolveIriAtPosition(line: string, char: number): string | undefined {
    const fullIriMatch = /<([^>]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = fullIriMatch.exec(line)) !== null) {
      if (char >= m.index && char <= m.index + m[0].length) {
        return m[1];
      }
    }

    const prefixedMatch = /(\w*):([A-Za-z_][\w.-]*)/g;
    const prefixes = this.store.getPrefixes();
    while ((m = prefixedMatch.exec(line)) !== null) {
      if (char >= m.index && char <= m.index + m[0].length) {
        const ns = prefixes.get(m[1]);
        if (ns) { return ns + m[2]; }
      }
    }

    return undefined;
  }
}
