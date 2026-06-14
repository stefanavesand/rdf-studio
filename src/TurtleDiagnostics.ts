import * as vscode from 'vscode';
import { RdfStore } from './store/RdfStore';

export class TurtleDiagnostics {
  private readonly collection: vscode.DiagnosticCollection;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly store: RdfStore) {
    this.collection = vscode.languages.createDiagnosticCollection('kgExplorer');

    this.disposables.push(
      this.collection,
      store.onDidReload(() => this.refreshAll()),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId === 'turtle') {
          this.diagnose(e.document);
        }
      }),
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.languageId === 'turtle') {
          this.diagnose(doc);
        }
      }),
    );
  }

  private refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.languageId === 'turtle') {
        this.diagnose(doc);
      }
    }
  }

  private diagnose(document: vscode.TextDocument): void {
    if (!this.store.isLoaded) { return; }

    const diagnostics: vscode.Diagnostic[] = [];
    const prefixes = new Map<string, string>();
    const definedSubjects = new Set<string>();
    const objectRefs: { iri: string; line: number; col: number }[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const text = document.lineAt(i).text;

      const prefixMatch = text.match(/@prefix\s+(\w*)\s*:\s*<([^>]+)>/);
      if (prefixMatch) {
        prefixes.set(prefixMatch[1], prefixMatch[2]);
        continue;
      }

      if (text.startsWith('#') || text.trim() === '') { continue; }

      const subjectMatch = text.match(/^(\w*):(\S+)/);
      if (subjectMatch && !text.startsWith('@')) {
        const ns = prefixes.get(subjectMatch[1]);
        if (ns) {
          definedSubjects.add(ns + subjectMatch[2].replace(/\s.*$/, ''));
        }
      }

      const iriRefs = /(\w*):([A-Za-z_][\w.-]*)/g;
      let m: RegExpExecArray | null;
      while ((m = iriRefs.exec(text)) !== null) {
        const prefix = m[1];
        if (text.startsWith('@prefix')) { break; }

        if (!prefixes.has(prefix) && !['a', 'true', 'false'].includes(prefix)) {
          const range = new vscode.Range(i, m.index, i, m.index + m[0].length);
          diagnostics.push(new vscode.Diagnostic(
            range,
            `Undefined prefix "${prefix}:"`,
            vscode.DiagnosticSeverity.Error,
          ));
        } else {
          const ns = prefixes.get(prefix);
          if (ns && m.index > 0) {
            objectRefs.push({ iri: ns + m[2], line: i, col: m.index });
          }
        }
      }
    }

    const allSubjects = new Set(definedSubjects);
    const rows = this.store.query(`
      SELECT DISTINCT ?s WHERE {
        ?s ?p ?o .
        FILTER(isIRI(?s))
      } LIMIT 5000
    `);
    for (const row of rows) {
      allSubjects.add(row.get('s')!.value);
    }

    for (const ref of objectRefs) {
      if (!allSubjects.has(ref.iri)) {
        const local = this.store.localName(ref.iri);
        const compact = this.store.compact(ref.iri);
        const range = new vscode.Range(ref.line, ref.col, ref.line, ref.col + compact.length);
        diagnostics.push(new vscode.Diagnostic(
          range,
          `Dangling reference: ${compact} is not defined as a subject`,
          vscode.DiagnosticSeverity.Warning,
        ));
      }
    }

    this.collection.set(document.uri, diagnostics);
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
  }
}
