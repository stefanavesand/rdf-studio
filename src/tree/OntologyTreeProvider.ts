import * as vscode from 'vscode';
import { RdfStore, ClassInfo, InstanceInfo } from '../store/RdfStore';
import { hueFor, hueToThemeColor } from '../typeColors';

export type TreeNode =
  | { kind: 'source'; sourceType: 'local' | 'remote'; name: string; url?: string; namespaces: TreeNode[] }
  | { kind: 'namespace'; ns: string; label: string; prefix: string; classes: ClassInfo[]; sourceType?: 'local' | 'remote' }
  | { kind: 'class'; data: ClassInfo; parentIri?: string; sourceType?: 'local' | 'remote' }
  | { kind: 'instance'; data: InstanceInfo; parentIri: string; sourceType?: 'local' | 'remote' };

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
      case 'source': {
        const item = new vscode.TreeItem(
          node.name,
          vscode.TreeItemCollapsibleState.Expanded,
        );
        if (node.sourceType === 'local') {
          item.iconPath = new vscode.ThemeIcon('folder-library');
          item.contextValue = 'localSource';
        } else {
          item.iconPath = new vscode.ThemeIcon('globe');
          item.contextValue = 'remoteSource';
        }
        item.description = '';
        item.id = `source:${node.sourceType}:${node.url ?? 'local'}`;
        return item;
      }
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
        const isRemote = node.sourceType === 'remote';
        const hasChildren = node.data.subClasses.length > 0 || node.data.instanceCount > 0 || isRemote;
        const item = new vscode.TreeItem(
          node.data.label,
          hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        item.description = isRemote ? '' : `${node.data.instanceCount}`;
        const themeColor = hueToThemeColor(hueFor(node.data.label));
        item.iconPath = new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor(themeColor));
        item.tooltip = `${node.data.label}${isRemote ? ' (remote)' : ` (${node.data.instanceCount} instances)`}\n${this.store.compact(node.data.iri)}`;
        item.contextValue = isRemote ? 'remoteClass' : 'class';
        item.id = `${node.sourceType ?? 'local'}:${node.data.iri}`;
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
        item.tooltip = node.sourceType === 'remote' ? `${node.data.iri} (remote)` : this.store.compact(node.data.iri);
        item.contextValue = node.sourceType === 'remote' ? 'remoteInstance' : 'instance';
        item.id = `${node.sourceType ?? 'local'}:${node.data.iri}`;
        item.command = {
          command: 'kgExplorer.showProperties',
          title: 'Show Properties',
          arguments: [node],
        };
        return item;
      }
    }
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!this.store.isLoaded) { return []; }

    if (!node) {
      return this.getSourceGroups();
    }

    if (node.kind === 'source') {
      return node.namespaces;
    }

    if (node.kind === 'namespace') {
      const src = node.sourceType ?? 'local';
      return node.classes.map(c => {
        const id = `${src}:${c.iri}`;
        const n: TreeNode = { kind: 'class', data: c, parentIri: `ns:${node.ns}`, sourceType: src };
        this.nodeIndex.set(id, n);
        return n;
      });
    }

    if (node.kind === 'class') {
      const src = node.sourceType ?? 'local';
      const children: TreeNode[] = [];

      for (const sub of node.data.subClasses) {
        // Filter subclasses by source: only show subclasses that belong to this source
        const subIsLocal = this.store.hasLocalNamespace(this.extractNamespace(sub.iri));
        if (src === 'local' && !subIsLocal) { continue; }
        if (src === 'remote' && subIsLocal) { continue; }
        const id = `${src}:${sub.iri}`;
        const n: TreeNode = { kind: 'class', data: sub, parentIri: node.data.iri, sourceType: src };
        this.nodeIndex.set(id, n);
        children.push(n);
      }

      if (src === 'local') {
        for (const inst of this.store.getInstances(node.data.iri)) {
          const n: TreeNode = { kind: 'instance', data: inst, parentIri: node.data.iri, sourceType: 'local' };
          this.nodeIndex.set(inst.iri, n);
          children.push(n);
        }
      } else {
        try {
          const remoteInstances = await this.store.getRemoteInstances(node.data.iri);
          for (const inst of remoteInstances) {
            const n: TreeNode = { kind: 'instance', data: inst, parentIri: node.data.iri, sourceType: 'remote' };
            this.nodeIndex.set(`remote:${inst.iri}`, n);
            children.push(n);
          }
        } catch { /* silent */ }
      }
      return children;
    }

    return [];
  }

  getParent(node: TreeNode): TreeNode | undefined {
    if (node.kind === 'source') { return undefined; }
    if (node.kind === 'namespace') {
      return this.nodeIndex.get(`source:${node.sourceType ?? 'local'}`) ?? undefined;
    }
    const parentIri = (node as any).parentIri;
    if (!parentIri) { return undefined; }
    return this.nodeIndex.get(parentIri);
  }

  private getSourceGroups(): TreeNode[] {
    const allNamespaces = this.getNamespaceGroups();
    const remoteEndpoints = this.store.getRemoteEndpoints();

    const localNs: TreeNode[] = [];
    const remoteNs: TreeNode[] = [];

    for (const ns of allNamespaces) {
      if (ns.kind !== 'namespace') { continue; }
      if (this.store.hasLocalNamespace(ns.ns)) {
        ns.sourceType = 'local';
        localNs.push(ns);
      } else {
        ns.sourceType = 'remote';
        remoteNs.push(ns);
      }
    }

    const sources: TreeNode[] = [];

    if (localNs.length > 0) {
      const localSource: TreeNode = {
        kind: 'source', sourceType: 'local', name: 'Local Files', namespaces: localNs,
      };
      this.nodeIndex.set('source:local', localSource);
      sources.push(localSource);
    }

    if (remoteNs.length > 0) {
      // Group remote namespaces under their endpoint names
      const endpointNames = [...remoteEndpoints.values()].map(e => e.name);
      const remoteName = endpointNames.length > 0 ? endpointNames.join(', ') : 'Remote';
      const remoteSource: TreeNode = {
        kind: 'source', sourceType: 'remote', name: remoteName,
        url: [...remoteEndpoints.keys()][0],
        namespaces: remoteNs,
      };
      this.nodeIndex.set('source:remote', remoteSource);
      sources.push(remoteSource);
    }

    return sources;
  }

  private getNamespaceGroups(): TreeNode[] {
    const hierarchy = this.store.getClassHierarchy();
    const prefixes = this.store.getPrefixes();

    // Collect ALL classes (including nested subclasses) grouped by namespace
    const nsMap = new Map<string, ClassInfo[]>();
    const collectAll = (classes: ClassInfo[]) => {
      for (const cls of classes) {
        const ns = this.extractNamespace(cls.iri);
        if (!nsMap.has(ns)) { nsMap.set(ns, []); }
        nsMap.get(ns)!.push(cls);
        if (cls.subClasses.length > 0) { collectAll(cls.subClasses); }
      }
    };
    collectAll(hierarchy);

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
