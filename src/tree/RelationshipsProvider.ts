import * as vscode from 'vscode';
import { RdfStore } from '../store/RdfStore';

interface LinkTarget {
  iri: string;
  label: string;
  type: string;
}

type RelNode =
  | { kind: 'section'; section: 'props' | 'relations'; iri: string }
  | { kind: 'group'; predicate: string; predicateLabel: string; typeSummary: string; targets: LinkTarget[]; direction: 'out' | 'in' }
  | { kind: 'entity'; iri: string; label: string; type: string; direction: 'out' | 'in'; predicate: string }
  | { kind: 'literal'; predicate: string; predicateLabel: string; value: string };

export class RelationshipsProvider implements vscode.TreeDataProvider<RelNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RelNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private selectedIri: string | undefined;

  constructor(private readonly store: RdfStore) {}

  select(iri: string): void {
    this.selectedIri = iri;
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: RelNode): vscode.TreeItem {
    switch (node.kind) {
      case 'section': {
        const icons: Record<string, string> = { props: 'symbol-field', relations: 'git-compare' };
        const labels: Record<string, string> = { props: 'Properties', relations: 'Relations' };
        const item = new vscode.TreeItem(
          labels[node.section],
          vscode.TreeItemCollapsibleState.Expanded,
        );
        item.iconPath = new vscode.ThemeIcon(icons[node.section]);
        return item;
      }
      case 'group': {
        if (node.targets.length === 1) {
          const t = node.targets[0];
          const label = node.direction === 'out'
            ? `${node.predicateLabel} → ${t.label}`
            : `${t.label} → ${node.predicateLabel}`;
          const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
          item.description = t.type;
          item.tooltip = this.edgeTooltip(node.direction, node.predicateLabel, t);
          item.contextValue = 'iriValue';
          item.id = `${this.selectedIri}|${node.direction}|${node.predicate}|${t.iri}`;
          item.command = {
            command: 'kgExplorer.showProperties',
            title: 'Navigate',
            arguments: [t.iri],
          };
          return item;
        }
        const label = node.direction === 'out'
          ? `${node.predicateLabel} →`
          : `→ ${node.predicateLabel}`;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = node.typeSummary;
        return item;
      }
      case 'entity': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.description = node.type;
        item.tooltip = `${node.label} (${node.type})\n${this.store.compact(node.iri)}`;
        item.contextValue = 'iriValue';
        item.id = `${this.selectedIri}|${node.direction}|${node.predicate}|${node.iri}`;
        item.command = {
          command: 'kgExplorer.showProperties',
          title: 'Navigate',
          arguments: [node.iri],
        };
        return item;
      }
      case 'literal': {
        const display = node.value.length > 80 ? node.value.slice(0, 77) + '...' : node.value;
        const item = new vscode.TreeItem(
          `${node.predicateLabel}  ${display}`,
          vscode.TreeItemCollapsibleState.None,
        );
        item.tooltip = `${node.predicateLabel}: ${node.value}`;
        return item;
      }
    }
  }

  getChildren(node?: RelNode): RelNode[] {
    if (!this.selectedIri || !this.store.isLoaded) { return []; }

    if (!node) {
      const outgoing = this.store.getOutgoing(this.selectedIri);
      const incoming = this.store.getIncoming(this.selectedIri);

      let hasLiterals = false;
      let hasLinks = false;
      for (const prop of outgoing) {
        for (const val of prop.values) {
          if (val.isIri) { hasLinks = true; } else { hasLiterals = true; }
        }
      }
      if (incoming.some(p => p.values.length > 0)) { hasLinks = true; }

      const sections: RelNode[] = [];
      if (hasLiterals) {
        sections.push({ kind: 'section', section: 'props', iri: this.selectedIri });
      }
      if (hasLinks) {
        sections.push({ kind: 'section', section: 'relations', iri: this.selectedIri });
      }
      return sections;
    }

    if (node.kind === 'section') {
      if (node.section === 'props') {
        return this.getLiterals(node.iri);
      }
      return [
        ...this.getGroups(node.iri, 'out'),
        ...this.getGroups(node.iri, 'in'),
      ];
    }

    if (node.kind === 'group') {
      return node.targets.map(t => ({
        kind: 'entity' as const,
        iri: t.iri,
        label: t.label,
        type: t.type,
        direction: node.direction,
        predicate: node.predicate,
      }));
    }

    return [];
  }

  private getLiterals(iri: string): RelNode[] {
    const outgoing = this.store.getOutgoing(iri);
    const rows: RelNode[] = [];
    for (const prop of outgoing) {
      for (const val of prop.values) {
        if (!val.isIri) {
          rows.push({
            kind: 'literal',
            predicate: prop.predicate,
            predicateLabel: prop.predicateLabel,
            value: val.value,
          });
        }
      }
    }
    return rows;
  }

  private getGroups(iri: string, direction: 'out' | 'in'): RelNode[] {
    const props = direction === 'out'
      ? this.store.getOutgoing(iri)
      : this.store.getIncoming(iri);

    const groups: RelNode[] = [];
    for (const prop of props) {
      const targets: LinkTarget[] = [];
      for (const val of prop.values) {
        if (val.isIri) {
          const types = this.store.getTypes(val.value);
          targets.push({ iri: val.value, label: val.label, type: types[0] ?? '' });
        }
      }
      if (targets.length === 0) { continue; }

      const typeSet = new Set(targets.map(t => t.type).filter(Boolean));
      const typeSummary = typeSet.size === 0 ? ''
        : typeSet.size === 1 ? [...typeSet][0]
        : [...typeSet].join(', ');

      groups.push({
        kind: 'group',
        predicate: prop.predicate,
        predicateLabel: prop.predicateLabel,
        typeSummary,
        targets,
        direction,
      });
    }
    return groups;
  }

  private edgeTooltip(direction: 'out' | 'in', predLabel: string, target: LinkTarget): string {
    const selected = this.selectedIri ? this.store.compact(this.selectedIri) : '?';
    const other = this.store.compact(target.iri);
    return direction === 'out'
      ? `${selected} —${predLabel}→ ${other} (${target.type})`
      : `${other} —${predLabel}→ ${selected} (${target.type})`;
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
