import * as vscode from 'vscode';
import { RdfStore, ClassInfo, InstanceInfo } from '../store/RdfStore';
import { hueFor, hueToThemeColor } from '../typeColors';

export type TreeNode =
  | { kind: 'namespace'; ns: string; label: string; prefix: string; classes: ClassInfo[] }
  | { kind: 'class'; data: ClassInfo; parentIri?: string }
  | { kind: 'instance'; data: InstanceInfo; parentIri: string };

export class OntologyTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private nodeIndex = new Map<string, TreeNode>();

  constructor(private readonly store: RdfStore) {
    store.onDidReload(() => {
      this.nodeIndex.clear();
      this._onDidChangeTreeData.fire(undefined);
    });
  }

  refresh(): void {
    this.nodeIndex.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  findNode(iri: string): TreeNode | undefined {
    if (this.nodeIndex.has(iri)) { return this.nodeIndex.get(iri); }

    const rows = this.store.query(`
      SELECT ?type WHERE {
        <${iri}> a ?type .
        ?type a <http://www.w3.org/2002/07/owl#Class> .
      } LIMIT 1
    `);
    if (rows.length === 0) { return undefined; }

    const classIri = rows[0].get('type')!.value;
    const classNode = this.nodeIndex.get(classIri);
    if (classNode) {
      this.getChildren(classNode);
      return this.nodeIndex.get(iri);
    }

    return undefined;
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'namespace': {
        const item = new vscode.TreeItem(
          node.label,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        item.description = node.prefix ? `${node.prefix}:` : '';
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.tooltip = `${node.label}\n${node.ns}\n${node.classes.length} types`;
        item.contextValue = 'namespace';
        item.id = `ns:${node.ns}`;
        item.command = {
          command: 'kgExplorer.showProperties',
          title: 'Show Ontology',
          arguments: [node],
        };
        return item;
      }
      case 'class': {
        const item = new vscode.TreeItem(
          node.data.label,
          (node.data.subClasses.length > 0 || node.data.instanceCount > 0)
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
        );
        item.description = `${node.data.instanceCount}`;
        const themeColor = hueToThemeColor(hueFor(node.data.label));
        item.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor(themeColor));
        item.tooltip = `${node.data.label} (${node.data.instanceCount} instances)\n${this.store.compact(node.data.iri)}`;
        item.contextValue = 'class';
        item.id = node.data.iri;
        item.command = {
          command: 'kgExplorer.showProperties',
          title: 'Show Properties',
          arguments: [node],
        };
        return item;
      }
      case 'instance': {
        const item = new vscode.TreeItem(node.data.label, vscode.TreeItemCollapsibleState.None);
        const parentClass = node.parentIri ? this.store.localName(node.parentIri) : '';
        const themeColor = hueToThemeColor(hueFor(parentClass));
        item.iconPath = new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor(themeColor));
        item.tooltip = this.store.compact(node.data.iri);
        item.contextValue = 'instance';
        item.id = node.data.iri;
        item.command = {
          command: 'kgExplorer.showProperties',
          title: 'Show Properties',
          arguments: [node.data.iri],
        };
        return item;
      }
    }
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!this.store.isLoaded) { return []; }

    if (!node) {
      return this.getNamespaceGroups();
    }

    if (node.kind === 'namespace') {
      return node.classes.map(c => {
        const n: TreeNode = { kind: 'class', data: c, parentIri: `ns:${node.ns}` };
        this.nodeIndex.set(c.iri, n);
        return n;
      });
    }

    if (node.kind === 'class') {
      const children: TreeNode[] = [];
      for (const sub of node.data.subClasses) {
        const n: TreeNode = { kind: 'class', data: sub, parentIri: node.data.iri };
        this.nodeIndex.set(sub.iri, n);
        children.push(n);
      }
      for (const inst of this.store.getInstances(node.data.iri)) {
        const n: TreeNode = { kind: 'instance', data: inst, parentIri: node.data.iri };
        this.nodeIndex.set(inst.iri, n);
        children.push(n);
      }
      return children;
    }

    return [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    if (node.kind === 'namespace') { return undefined; }
    const parentIri = node.parentIri;
    if (!parentIri) { return undefined; }
    return this.nodeIndex.get(parentIri);
  }

  private getNamespaceGroups(): TreeNode[] {
    const hierarchy = this.store.getClassHierarchy();
    const prefixes = this.store.getPrefixes();

    const nsMap = new Map<string, ClassInfo[]>();
    for (const cls of hierarchy) {
      const ns = this.extractNamespace(cls.iri);
      if (!nsMap.has(ns)) { nsMap.set(ns, []); }
      nsMap.get(ns)!.push(cls);
    }

    // build reverse prefix map: namespace → prefix name
    const nsToPrefix = new Map<string, string>();
    for (const [prefix, ns] of prefixes) {
      if (prefix && !nsToPrefix.has(ns)) {
        nsToPrefix.set(ns, prefix);
      }
    }

    // look up owl:Ontology labels
    const ontologyLabels = new Map<string, string>();
    const ontRows = this.store.query(`
      SELECT ?ont ?label WHERE {
        ?ont a owl:Ontology .
        ?ont rdfs:label ?label .
      }
    `);
    for (const r of ontRows) {
      const ontNs = r.get('ont')!.value;
      ontologyLabels.set(ontNs, r.get('label')!.value);
    }

    // ensure declared ontologies appear even with zero classes
    for (const [ontNs] of ontologyLabels) {
      if (!nsMap.has(ontNs)) { nsMap.set(ontNs, []); }
    }

    const groups: TreeNode[] = [];
    for (const [ns, classes] of nsMap) {
      const prefix = nsToPrefix.get(ns) ?? '';
      const label = ontologyLabels.get(ns) ?? this.namespaceLabel(ns, prefix);
      const n: TreeNode = { kind: 'namespace', ns, label, prefix, classes: classes.sort((a, b) => a.label.localeCompare(b.label)) };
      this.nodeIndex.set(`ns:${ns}`, n);
      groups.push(n);
    }

    return groups.sort((a, b) => {
      if (a.kind !== 'namespace' || b.kind !== 'namespace') { return 0; }
      const aCount = a.classes.reduce((n, c) => n + c.instanceCount, 0);
      const bCount = b.classes.reduce((n, c) => n + c.instanceCount, 0);
      return bCount - aCount;
    });
  }

  private extractNamespace(iri: string): string {
    const hashIdx = iri.lastIndexOf('#');
    if (hashIdx >= 0) { return iri.substring(0, hashIdx + 1); }
    const slashIdx = iri.lastIndexOf('/');
    if (slashIdx >= 0) { return iri.substring(0, slashIdx + 1); }
    return iri;
  }

  private namespaceLabel(ns: string, prefix: string): string {
    if (prefix) {
      const parts = ns.replace(/[#/]$/, '').split('/');
      const meaningful = parts.filter(p => p && p !== 'http:' && p !== 'https:' && !p.includes('.'));
      const last = meaningful.length > 0 ? meaningful[meaningful.length - 1] : prefix;
      return last.charAt(0).toUpperCase() + last.slice(1).replace(/[-_]/g, ' ');
    }
    const parts = ns.replace(/[#/]$/, '').split('/');
    return parts[parts.length - 1] || ns;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
