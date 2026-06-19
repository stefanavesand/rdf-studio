import * as vscode from 'vscode';
import { RdfStore } from './RdfStore';

export class TurtleEditor {
  constructor(private readonly store: RdfStore) {}

  async deleteTriple(subjectIri: string, predicateIri: string, objectValue: string, label?: string): Promise<boolean> {
    const loc = this.store.getDefinitionLocation(subjectIri);
    if (!loc) { return false; }

    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const text = doc.getText();
    const lines = text.split('\n');

    const predCompact = this.store.compact(predicateIri);
    const predLocal = this.store.localName(predicateIri);

    const matchers = label
      ? [label, ...this.buildObjectMatchers(subjectIri, predicateIri, objectValue)]
      : this.buildObjectMatchers(subjectIri, predicateIri, objectValue);

    const subjectLine = loc.line;
    const blockEnd = this.findBlockEnd(lines, subjectLine);

    console.log(`[KG] deleteTriple: predCompact="${predCompact}", predLocal="${predLocal}"`);
    console.log(`[KG] deleteTriple: matchers=${JSON.stringify(matchers)}`);
    console.log(`[KG] deleteTriple: subjectLine=${subjectLine}, blockEnd=${blockEnd}`);
    for (let d = subjectLine; d <= blockEnd; d++) {
      console.log(`[KG]   ${d}: ${lines[d]}`);
    }

    // pass 1: predicate + object on the same line
    for (let i = subjectLine; i <= blockEnd; i++) {
      const line = lines[i];
      const hasPred = line.includes(predCompact) || line.includes(predLocal);
      if (!hasPred) { continue; }
      if (matchers.some(c => line.includes(c))) {
        return await this.removeLine(doc, lines, i, subjectLine, blockEnd);
      }
    }

    // pass 2: find the line with the object (handles blank nodes where
    // predicate and object content are on different lines) — open the file
    // at that location so the user can edit the blank node manually
    for (let i = subjectLine; i <= blockEnd; i++) {
      const line = lines[i];
      if (matchers.some(c => line.includes(c))) {
        const blockText = lines.slice(subjectLine, i + 1).join('\n');
        if (blockText.includes(predCompact) || blockText.includes(predLocal)) {
          const editor = await vscode.window.showTextDocument(doc);
          const range = new vscode.Range(i, 0, i, 0);
          editor.selection = new vscode.Selection(range.start, range.start);
          editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
          vscode.window.showInformationMessage('Inline blank node — opened at the line for manual editing.');
          return true;
        }
      }
    }

    return false;
  }

  async deleteSubjectBlock(subjectIri: string): Promise<boolean> {
    const loc = this.store.getDefinitionLocation(subjectIri);
    if (!loc) { return false; }

    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const text = doc.getText();
    const lines = text.split('\n');

    const startLine = loc.line;
    const blockEnd = this.findBlockEnd(lines, startLine);

    // expand upward to include blank lines before the block
    let deleteStart = startLine;
    while (deleteStart > 0 && lines[deleteStart - 1].trim() === '') {
      deleteStart--;
    }

    // expand downward to include trailing blank line
    let deleteEnd = blockEnd + 1;
    if (deleteEnd < lines.length && lines[deleteEnd].trim() === '') {
      deleteEnd++;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.delete(doc.uri, new vscode.Range(deleteStart, 0, deleteEnd, 0));

    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) { await doc.save(); }
    return ok;
  }

  async addTriple(subjectIri: string, predicateIri: string, objectValue: string, isLiteral: boolean): Promise<boolean> {
    const loc = this.store.getDefinitionLocation(subjectIri);
    if (!loc) { return false; }

    const doc = await vscode.workspace.openTextDocument(loc.uri);
    const text = doc.getText();
    const lines = text.split('\n');

    const subjectLine = loc.line;
    const blockEnd = this.findBlockEnd(lines, subjectLine);
    // Only use prefixes declared in this file
    const filePrefixes = new Set<string>();
    for (const line of lines) {
      const m = line.match(/@prefix\s+(\S+):\s*<([^>]+)>/);
      if (m) { filePrefixes.add(m[2]); }
    }
    const compactForFile = (iri: string): string => {
      const compacted = this.store.compact(iri);
      if (!compacted.includes(':')) { return `<${iri}>`; }
      const prefix = compacted.split(':')[0];
      const ns = this.store.getPrefixes().get(prefix);
      if (ns && filePrefixes.has(ns)) { return compacted; }
      return `<${iri}>`;
    };
    const predCompact = compactForFile(predicateIri);
    const objText = isLiteral ? `"${objectValue}"` : compactForFile(objectValue);

    const lastLine = lines[blockEnd];
    const indent = this.detectIndent(lines, subjectLine, blockEnd);

    const edit = new vscode.WorkspaceEdit();

    if (lastLine.trimEnd().endsWith('.')) {
      const dotPos = lastLine.lastIndexOf('.');
      const before = lastLine.substring(0, dotPos).trimEnd();
      edit.replace(doc.uri,
        new vscode.Range(blockEnd, 0, blockEnd, lastLine.length),
        before + ' ;\n' + indent + predCompact + ' ' + objText + ' .'
      );
    } else {
      edit.insert(doc.uri,
        new vscode.Position(blockEnd + 1, 0),
        indent + predCompact + ' ' + objText + ' .\n'
      );
    }

    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) { await doc.save(); }
    return ok;
  }

  async addNewSubject(fileUri: vscode.Uri, subjectIri: string, typeIri: string,
    predicateIri: string, objectValue: string, isLiteral: boolean): Promise<boolean> {

    const doc = await vscode.workspace.openTextDocument(fileUri);
    const text = doc.getText();
    const subjCompact = this.safeCompact(subjectIri);
    const typeCompact = this.safeCompact(typeIri);
    const predCompact = this.safeCompact(predicateIri);
    const objText = isLiteral ? `"${objectValue}"` : this.safeCompact(objectValue);

    const newBlock = `\n${subjCompact} a ${typeCompact} ;\n    ${predCompact} ${objText} .\n`;

    const edit = new vscode.WorkspaceEdit();
    const lastLine = doc.lineCount - 1;
    edit.insert(doc.uri, new vscode.Position(lastLine, doc.lineAt(lastLine).text.length), newBlock);

    return await vscode.workspace.applyEdit(edit);
  }

  private findBlockEnd(lines: string[], startLine: number): number {
    let inTripleQuote = false;
    for (let i = startLine; i < lines.length; i++) {
      const tqCount = (lines[i].match(/"""/g) ?? []).length;
      if (tqCount % 2 !== 0) { inTripleQuote = !inTripleQuote; }
      if (!inTripleQuote && lines[i].trimEnd().endsWith('.')) {
        return i;
      }
    }
    return startLine;
  }

  private lineMatchesTriple(line: string, predCompact: string, predLocal: string,
    objCompact: string, objValue: string): boolean {

    const cleaned = line.replace(/[;.]$/, '').trim();
    const hasPred = cleaned.includes(predCompact) || cleaned.includes(predLocal);
    if (!hasPred) { return false; }

    const hasObj = cleaned.includes(objCompact)
      || cleaned.includes(`"${objValue}"`)
      || cleaned.includes(this.store.localName(objValue))
      || cleaned.includes(objValue);
    return hasObj;
  }

  private async removeLine(doc: vscode.TextDocument, lines: string[], targetLine: number,
    subjectLine: number, blockEnd: number): Promise<boolean> {

    const edit = new vscode.WorkspaceEdit();

    if (targetLine === subjectLine && targetLine === blockEnd) {
      edit.delete(doc.uri, new vscode.Range(targetLine, 0, targetLine + 1, 0));
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) { await doc.save(); }
      return ok;
    }

    if (targetLine === blockEnd) {
      for (let i = targetLine - 1; i >= subjectLine; i--) {
        const prev = lines[i].trimEnd();
        if (prev.endsWith(';') || prev.endsWith('.') || prev.length > 0) {
          const prevLine = lines[i];
          const trimmed = prevLine.trimEnd();
          if (trimmed.endsWith(';')) {
            edit.replace(doc.uri,
              new vscode.Range(i, 0, targetLine + 1, 0),
              trimmed.slice(0, -1) + '.\n'
            );
          } else {
            edit.delete(doc.uri, new vscode.Range(targetLine, 0, targetLine + 1, 0));
          }
          break;
        }
      }
    } else {
      edit.delete(doc.uri, new vscode.Range(targetLine, 0, targetLine + 1, 0));
    }

    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) { await doc.save(); }
    return ok;
  }

  private buildObjectMatchers(subjectIri: string, predicateIri: string, objectValue: string): string[] {
    const matchers: string[] = [];
    const isBlankNode = !objectValue.includes(':') && !objectValue.includes('/');

    if (!isBlankNode) {
      matchers.push(this.store.compact(objectValue));
      matchers.push(this.store.localName(objectValue));
      matchers.push(objectValue);
      try {
        const label = this.store.getLabel(objectValue);
        if (label) { matchers.push(label); }
      } catch { /* */ }
    }

    // for blank nodes (or as fallback), find the object's label via the triple
    if (isBlankNode || matchers.length === 0) {
      try {
        const rows = this.store.query(`
          SELECT ?label WHERE {
            <${subjectIri}> <${predicateIri}> ?o .
            ?o rdfs:label ?label .
          }
        `);
        for (const r of rows) {
          const label = r.get('label')?.value;
          if (label) { matchers.push(label); }
        }
      } catch { /* */ }
    }

    return matchers.filter(m => m && m.length > 1);
  }

  private safeCompact(iri: string): string {
    const compacted = this.store.compact(iri);
    return compacted.includes(':') ? compacted : `<${iri}>`;
  }

  private detectIndent(lines: string[], startLine: number, endLine: number): string {
    for (let i = startLine + 1; i <= endLine; i++) {
      const match = lines[i].match(/^(\s+)/);
      if (match) { return match[1]; }
    }
    return '    ';
  }
}
