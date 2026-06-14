import * as vscode from 'vscode';
import { RdfStore } from './store/RdfStore';

const CANNED_QUERIES = [
  {
    label: 'All classes with instance counts',
    sparql: `SELECT ?cls ?label (COUNT(?inst) AS ?count) WHERE {
  ?inst a ?cls .
  ?cls a owl:Class .
  OPTIONAL { ?cls rdfs:label ?label }
} GROUP BY ?cls ?label ORDER BY DESC(?count)`,
  },
  {
    label: 'Instances missing labels',
    sparql: `SELECT ?inst ?type WHERE {
  ?inst a ?type .
  ?type a owl:Class .
  FILTER(isIRI(?inst))
  FILTER NOT EXISTS { ?inst rdfs:label ?label }
} ORDER BY ?type LIMIT 100`,
  },
  {
    label: 'All properties used',
    sparql: `SELECT ?p ?pLabel (COUNT(*) AS ?usage) WHERE {
  ?s ?p ?o .
  OPTIONAL { ?p rdfs:label ?pLabel }
  FILTER(?p != rdf:type && ?p != rdfs:subClassOf)
} GROUP BY ?p ?pLabel ORDER BY DESC(?usage)`,
  },
  {
    label: 'SOPs by automation pattern',
    sparql: `SELECT ?sop ?label ?pattern WHERE {
  ?sop a :StandardOperatingProcedure ;
       rdfs:label ?label ;
       :automationPattern ?pattern .
} ORDER BY ?pattern ?label`,
  },
  {
    label: 'Disconnected instances (no outgoing links)',
    sparql: `SELECT ?inst ?label ?type WHERE {
  ?inst a ?type .
  ?type a owl:Class .
  OPTIONAL { ?inst rdfs:label ?label }
  FILTER(isIRI(?inst))
  FILTER NOT EXISTS {
    ?inst ?p ?o .
    FILTER(?p != rdf:type && ?p != rdfs:label && ?p != rdfs:comment)
  }
} ORDER BY ?type LIMIT 50`,
  },
];

export class SparqlPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly store: RdfStore,
    private readonly extensionUri: vscode.Uri,
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'kgExplorer.sparql',
      'SPARQL Query',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel.iconPath = new vscode.ThemeIcon('database');
    this.panel.webview.html = this.getHtml();

    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'run') {
        this.runQuery(msg.sparql);
      } else if (msg.type === 'goToDefinition') {
        vscode.commands.executeCommand('kgExplorer.goToDefinition', msg.iri);
      }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  private runQuery(sparql: string): void {
    if (!this.panel) { return; }
    try {
      const start = Date.now();
      const rows = this.store.query(sparql);
      const elapsed = Date.now() - start;

      if (rows.length === 0) {
        this.panel.webview.postMessage({ type: 'result', columns: [], rows: [], elapsed, count: 0 });
        return;
      }

      const columns = [...rows[0].keys()];
      const data = rows.map(row =>
        columns.map(col => {
          const term = row.get(col);
          if (!term) { return { value: '', display: '', isIri: false }; }
          const isIri = term.termType === 'NamedNode';
          return {
            value: term.value,
            display: isIri ? this.store.compact(term.value) : term.value,
            isIri,
          };
        })
      );

      this.panel.webview.postMessage({
        type: 'result',
        columns,
        rows: data,
        elapsed,
        count: rows.length,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.panel.webview.postMessage({ type: 'error', message: msg });
    }
  }

  private getHtml(): string {
    const cannedOptions = CANNED_QUERIES.map(
      (q, i) => `<option value="${i}">${q.label}</option>`
    ).join('');

    const cannedJson = JSON.stringify(CANNED_QUERIES.map(q => q.sparql));

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 12px;
    margin: 0;
  }
  .toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 8px;
  }
  .toolbar select, .toolbar button {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    padding: 4px 8px;
    border-radius: 2px;
  }
  .toolbar button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    cursor: pointer;
    font-weight: bold;
    padding: 4px 16px;
  }
  .toolbar button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  textarea {
    width: 100%;
    min-height: 120px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    padding: 8px;
    border-radius: 2px;
    resize: vertical;
    box-sizing: border-box;
  }
  .status {
    margin: 8px 0;
    font-size: 0.9em;
    color: var(--vscode-descriptionForeground);
  }
  .error {
    color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    padding: 8px;
    border-radius: 2px;
    margin: 8px 0;
    white-space: pre-wrap;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 8px;
    font-size: 0.9em;
  }
  th {
    text-align: left;
    padding: 6px 8px;
    background: var(--vscode-editor-lineHighlightBackground);
    border-bottom: 2px solid var(--vscode-panel-border);
    position: sticky;
    top: 0;
  }
  td {
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    max-width: 400px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  tr:hover td {
    background: var(--vscode-list-hoverBackground);
  }
  a {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    cursor: pointer;
  }
  a:hover { text-decoration: underline; }
  .results-wrap {
    max-height: calc(100vh - 260px);
    overflow: auto;
  }
  kbd {
    background: var(--vscode-keybindingLabel-background);
    border: 1px solid var(--vscode-keybindingLabel-border);
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 0.85em;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <select id="canned">
      <option value="-1">-- Preset queries --</option>
      ${cannedOptions}
    </select>
    <button id="run">Run <kbd>Ctrl+Enter</kbd></button>
  </div>
  <textarea id="sparql" placeholder="Enter SPARQL SELECT query..." spellcheck="false"></textarea>
  <div id="status" class="status"></div>
  <div id="output" class="results-wrap"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const canned = ${cannedJson};
    const textarea = document.getElementById('sparql');
    const output = document.getElementById('output');
    const status = document.getElementById('status');

    document.getElementById('canned').addEventListener('change', (e) => {
      const idx = parseInt(e.target.value);
      if (idx >= 0) { textarea.value = canned[idx]; }
    });

    function run() {
      const sparql = textarea.value.trim();
      if (!sparql) return;
      status.textContent = 'Running...';
      output.innerHTML = '';
      vscode.postMessage({ type: 'run', sparql });
    }

    document.getElementById('run').addEventListener('click', run);
    textarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { run(); }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'result') {
        if (msg.count === 0) {
          status.textContent = 'No results (' + msg.elapsed + 'ms)';
          output.innerHTML = '';
          return;
        }
        status.textContent = msg.count + ' rows (' + msg.elapsed + 'ms)';
        let html = '<table><thead><tr>';
        for (const col of msg.columns) { html += '<th>' + col + '</th>'; }
        html += '</tr></thead><tbody>';
        for (const row of msg.rows) {
          html += '<tr>';
          for (const cell of row) {
            if (cell.isIri) {
              html += '<td><a title="' + esc(cell.value) + '" onclick="goTo(\\'' + esc(cell.value) + '\\')">' + esc(cell.display) + '</a></td>';
            } else {
              html += '<td title="' + esc(cell.value) + '">' + esc(cell.display) + '</td>';
            }
          }
          html += '</tr>';
        }
        html += '</tbody></table>';
        output.innerHTML = html;
      } else if (msg.type === 'error') {
        status.textContent = '';
        output.innerHTML = '<div class="error">' + esc(msg.message) + '</div>';
      }
    });

    function goTo(iri) {
      vscode.postMessage({ type: 'goToDefinition', iri });
    }

    function esc(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
