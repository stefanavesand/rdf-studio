# RDF Studio

A VS Code extension for building and exploring RDF knowledge graphs. It loads Turtle (.ttl) files into an in-memory SPARQL store and provides a visual editor for ontologies, entities, and their relationships.

Built on [Oxigraph](https://github.com/oxigraph/oxigraph) WASM for in-memory SPARQL 1.1 support — no external triplestore needed.

## Features

### Ontology Browser
- **Namespace-grouped tree** with type-colored icons
- **Schema view** for OWL classes showing declared properties, domain/range, and SHACL constraint severity (Required / Recommended / Optional)
- **Ontology overview** with stats, imports management, and description

### Triple Table Editor
- **Instance view** with Source · Relation · Target columns
- **Parameters** (literal values), **Outgoing** and **Incoming** relationship sections with fan-in grouping
- **Type-colored entity boxes** with the entity type's HSL hue, consistent across tree and relationships
- **Inline cell editing** — click a value to edit, Enter to save, Esc to cancel
- **Delete** with toast notification and Undo support

### Full CRUD
- **Create** ontologies, classes, properties, and instances via modal dialog forms
- **Edit** labels, comments, and namespace URIs via pencil icon
- **Add/remove** relationships and imports
- **Schema-guided** property creation with entity type and datatype range picker
- **Auto-prefix injection** — cross-ontology references automatically add missing `@prefix` declarations

### SPARQL & Visualization
- **SPARQL query panel** with preset queries and clickable result tables
- **Neighborhood graph** — force-directed canvas showing an entity's direct connections

### Turtle Language Support
- **Hover** — label, types, and comment on prefixed names
- **Go to Definition** (F12) — jump to where an entity is defined
- **Autocomplete** — type `:` after a prefix for resource/property completions
- **Document Outline** (Cmd+Shift+O) — all subjects in a file
- **Diagnostics** — undefined prefixes and dangling references

### Theme Support
- Full **light and dark theme** support via VS Code CSS variables
- Type-color system with curated hue overrides and automatic lightness band switching
- Content Security Policy with nonce for marketplace-grade security

## Install

### From source

```sh
git clone https://github.com/stefanavesand/rdf-studio.git
cd rdf-studio
npm install
npm run compile
npx vsce package
code --install-extension rdf-studio-0.1.0.vsix
```

Then reload VS Code. The extension activates automatically when your workspace contains `.ttl` files.

## How it works

On activation, the extension loads all `.ttl` files in the workspace into an in-memory Oxigraph store. All queries (tree views, search, SPARQL panel) run as SPARQL against this store. Changes are written back to the TTL files via VS Code's `WorkspaceEdit` API, supporting undo/redo and source control integration.

## Development

```sh
npm install
npm run watch    # recompile on change
```

Press F5 in VS Code to launch an Extension Development Host for testing.

```sh
npm test         # run mocha tests
npm run compile  # one-shot compile
npx vsce package # build .vsix
```

## License

MIT — see [LICENSE](LICENSE).
