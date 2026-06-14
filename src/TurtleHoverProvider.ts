import * as vscode from 'vscode';
import { RdfStore } from './store/RdfStore';

export class TurtleHoverProvider implements vscode.HoverProvider {
  constructor(private readonly store: RdfStore) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    if (!this.store.isLoaded) { return; }

    const line = document.lineAt(position).text;
    const iri = this.resolveIriAtPosition(line, position.character);
    if (!iri) { return; }

    const label = this.store.getLabel(iri);
    const comment = this.store.getComment(iri);
    const types = this.store.getTypes(iri);
    const compact = this.store.compact(iri);

    if (!label && !comment && types.length === 0) { return; }

    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${label ?? this.store.localName(iri)}**`);
    md.appendMarkdown(`  \n\`${compact}\``);
    if (types.length > 0) {
      md.appendMarkdown(`  \n*${types.join(', ')}*`);
    }
    if (comment) {
      md.appendMarkdown(`\n\n${comment}`);
    }

    return new vscode.Hover(md);
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
        const prefix = m[1];
        const local = m[2];
        const ns = prefixes.get(prefix);
        if (ns) {
          return ns + local;
        }
      }
    }

    return undefined;
  }
}
