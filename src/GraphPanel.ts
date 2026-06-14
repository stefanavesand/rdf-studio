import * as vscode from 'vscode';
import { RdfStore } from './store/RdfStore';

interface GraphNode {
  id: string;
  label: string;
  type: string;
  isFocus: boolean;
}

interface GraphEdge {
  source: string;
  target: string;
  label: string;
}

export class GraphPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(private readonly store: RdfStore) {}

  show(focusIri: string): void {
    const { nodes, edges } = this.buildNeighborhood(focusIri);
    if (nodes.length === 0) { return; }

    const label = this.store.getLabel(focusIri) ?? this.store.localName(focusIri);

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'kgExplorer.graph',
        `Graph: ${label}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
      this.panel.onDidDispose(() => { this.panel = undefined; });

      this.panel.webview.onDidReceiveMessage((msg) => {
        if (msg.type === 'navigate') {
          this.show(msg.iri);
          vscode.commands.executeCommand('kgExplorer.showProperties', msg.iri);
        } else if (msg.type === 'goToDefinition') {
          vscode.commands.executeCommand('kgExplorer.goToDefinition', msg.iri);
        }
      });
    }

    this.panel.title = `Graph: ${label}`;
    this.panel.webview.html = this.getHtml(nodes, edges, focusIri);
    this.panel.reveal(vscode.ViewColumn.Beside, true);
  }

  private buildNeighborhood(focusIri: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
    const nodeMap = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];

    const addNode = (iri: string, isFocus: boolean) => {
      if (nodeMap.has(iri)) {
        if (isFocus) { nodeMap.get(iri)!.isFocus = true; }
        return;
      }
      const types = this.store.getTypes(iri);
      nodeMap.set(iri, {
        id: iri,
        label: this.store.getLabel(iri) ?? this.store.localName(iri),
        type: types[0] ?? 'Resource',
        isFocus,
      });
    };

    addNode(focusIri, true);

    const outgoing = this.store.getOutgoing(focusIri);
    for (const prop of outgoing) {
      for (const val of prop.values) {
        if (val.isIri) {
          addNode(val.value, false);
          edges.push({ source: focusIri, target: val.value, label: prop.predicateLabel });
        }
      }
    }

    const incoming = this.store.getIncoming(focusIri);
    for (const prop of incoming) {
      for (const val of prop.values) {
        addNode(val.value, false);
        edges.push({ source: val.value, target: focusIri, label: prop.predicateLabel });
      }
    }

    return { nodes: [...nodeMap.values()], edges };
  }

  private getHtml(nodes: GraphNode[], edges: GraphEdge[], focusIri: string): string {
    const nodesJson = JSON.stringify(nodes);
    const edgesJson = JSON.stringify(edges);

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--vscode-editor-background);
    overflow: hidden;
    font-family: var(--vscode-font-family);
  }
  canvas { display: block; cursor: grab; }
  canvas:active { cursor: grabbing; }
  #tooltip {
    position: absolute;
    display: none;
    background: var(--vscode-editorHoverWidget-background);
    border: 1px solid var(--vscode-editorHoverWidget-border);
    color: var(--vscode-editorHoverWidget-foreground);
    padding: 4px 8px;
    border-radius: 3px;
    font-size: 12px;
    pointer-events: none;
    max-width: 300px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #legend {
    position: absolute;
    top: 8px;
    right: 8px;
    background: var(--vscode-editorHoverWidget-background);
    border: 1px solid var(--vscode-editorHoverWidget-border);
    padding: 8px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--vscode-foreground);
  }
  .legend-item { display: flex; align-items: center; gap: 6px; margin: 2px 0; }
  .legend-dot { width: 10px; height: 10px; border-radius: 50%; }
  #controls {
    position: absolute;
    bottom: 8px;
    left: 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="tooltip"></div>
<div id="legend"></div>
<div id="controls">Click: navigate &middot; Right-click: go to source &middot; Drag: pan &middot; Scroll: zoom</div>
<script>
const vscode = acquireVsCodeApi();
const nodes = ${nodesJson};
const edges = ${edgesJson};
const focusIri = ${JSON.stringify(focusIri)};

const TYPE_COLORS = {
  'Class': '#4fc3f7',
  'Process': '#81c784',
  'StandardOperatingProcedure': '#ffb74d',
  'SOXControl': '#e57373',
  'System': '#ba68c8',
  'Role': '#4dd0e1',
  'Journey': '#aed581',
  'AccountingArea': '#fff176',
  'DataObject': '#90a4ae',
  'Resource': '#78909c',
};

function colorFor(type) {
  for (const [k, v] of Object.entries(TYPE_COLORS)) {
    if (type.includes(k)) return v;
  }
  return '#78909c';
}

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const tooltip = document.getElementById('tooltip');
let W, H;

function resize() {
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
resize();
window.addEventListener('resize', () => { resize(); draw(); });

// Init positions
for (const n of nodes) {
  if (n.isFocus) {
    n.x = W / 2; n.y = H / 2;
  } else {
    const angle = Math.random() * Math.PI * 2;
    const r = 120 + Math.random() * 80;
    n.x = W / 2 + Math.cos(angle) * r;
    n.y = H / 2 + Math.sin(angle) * r;
  }
  n.vx = 0; n.vy = 0;
}

const nodeById = new Map(nodes.map(n => [n.id, n]));

// Build legend
const types = [...new Set(nodes.map(n => n.type))].sort();
const legend = document.getElementById('legend');
legend.innerHTML = types.map(t =>
  '<div class="legend-item"><div class="legend-dot" style="background:' + colorFor(t) + '"></div>' + t + '</div>'
).join('');

// Force simulation
function simulate() {
  const k = 0.01;
  const repulse = 8000;
  const edgeLen = 150;
  const damping = 0.85;

  for (const a of nodes) {
    for (const b of nodes) {
      if (a === b) continue;
      let dx = a.x - b.x, dy = a.y - b.y;
      let dist = Math.sqrt(dx * dx + dy * dy) || 1;
      let f = repulse / (dist * dist);
      a.vx += (dx / dist) * f;
      a.vy += (dy / dist) * f;
    }
  }

  for (const e of edges) {
    const a = nodeById.get(e.source);
    const b = nodeById.get(e.target);
    if (!a || !b) continue;
    let dx = b.x - a.x, dy = b.y - a.y;
    let dist = Math.sqrt(dx * dx + dy * dy) || 1;
    let f = (dist - edgeLen) * k;
    let fx = (dx / dist) * f;
    let fy = (dy / dist) * f;
    a.vx += fx; a.vy += fy;
    b.vx -= fx; b.vy -= fy;
  }

  // Center gravity
  for (const n of nodes) {
    n.vx += (W / 2 - n.x) * 0.001;
    n.vy += (H / 2 - n.y) * 0.001;
    n.vx *= damping;
    n.vy *= damping;
    if (!n.pinned) {
      n.x += n.vx;
      n.y += n.vy;
    }
  }
}

// Camera
let camX = 0, camY = 0, zoom = 1;

function toScreen(x, y) {
  return [(x + camX) * zoom + W / 2, (y + camY) * zoom + H / 2];
}
function toWorld(sx, sy) {
  return [(sx - W / 2) / zoom - camX, (sy - H / 2) / zoom - camY];
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(zoom, zoom);
  ctx.translate(camX, camY);

  // Edges
  for (const e of edges) {
    const a = nodeById.get(e.source);
    const b = nodeById.get(e.target);
    if (!a || !b) continue;

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = 'rgba(150,150,150,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Arrow
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const r = b.isFocus ? 20 : 14;
    const ax = b.x - Math.cos(angle) * r;
    const ay = b.y - Math.sin(angle) * r;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(ax - Math.cos(angle - 0.3) * 8, ay - Math.sin(angle - 0.3) * 8);
    ctx.lineTo(ax - Math.cos(angle + 0.3) * 8, ay - Math.sin(angle + 0.3) * 8);
    ctx.closePath();
    ctx.fillStyle = 'rgba(150,150,150,0.6)';
    ctx.fill();

    // Edge label
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    ctx.fillStyle = 'rgba(180,180,180,0.7)';
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(e.label, mx, my - 4);
  }

  // Nodes
  for (const n of nodes) {
    const r = n.isFocus ? 20 : 14;
    const color = colorFor(n.type);

    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.globalAlpha = n.isFocus ? 1 : 0.85;
    ctx.fill();
    ctx.globalAlpha = 1;

    if (n.isFocus) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    ctx.fillStyle = '#000000';
    ctx.font = (n.isFocus ? 'bold ' : '') + '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const maxChars = 18;
    const display = n.label.length > maxChars ? n.label.slice(0, maxChars - 1) + '…' : n.label;
    ctx.fillText(display, n.x, n.y + r + 12);
  }

  ctx.restore();
}

// Animation loop
let running = true;
let frame = 0;
function tick() {
  if (!running) return;
  simulate();
  draw();
  frame++;
  if (frame < 300) requestAnimationFrame(tick);
  else { draw(); }
}
tick();

// Interaction
let dragNode = null;
let panning = false;
let panStart = null;

function nodeAt(sx, sy) {
  const [wx, wy] = toWorld(sx, sy);
  for (const n of nodes) {
    const r = n.isFocus ? 20 : 14;
    const dx = n.x - wx, dy = n.y - wy;
    if (dx * dx + dy * dy < (r + 4) * (r + 4)) return n;
  }
  return null;
}

canvas.addEventListener('mousedown', (e) => {
  const n = nodeAt(e.offsetX, e.offsetY);
  if (n) {
    dragNode = n;
    n.pinned = true;
  } else {
    panning = true;
    panStart = { x: e.offsetX, y: e.offsetY, cx: camX, cy: camY };
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (dragNode) {
    const [wx, wy] = toWorld(e.offsetX, e.offsetY);
    dragNode.x = wx;
    dragNode.y = wy;
    frame = 0;
    if (!running) { running = true; tick(); }
  } else if (panning && panStart) {
    camX = panStart.cx + (e.offsetX - panStart.x) / zoom;
    camY = panStart.cy + (e.offsetY - panStart.y) / zoom;
    draw();
  } else {
    const n = nodeAt(e.offsetX, e.offsetY);
    if (n) {
      tooltip.style.display = 'block';
      tooltip.style.left = (e.offsetX + 12) + 'px';
      tooltip.style.top = (e.offsetY - 8) + 'px';
      tooltip.textContent = n.label + ' (' + n.type + ')';
      canvas.style.cursor = 'pointer';
    } else {
      tooltip.style.display = 'none';
      canvas.style.cursor = 'grab';
    }
  }
});

canvas.addEventListener('mouseup', (e) => {
  if (dragNode) {
    const moved = false;
    dragNode.pinned = false;
    dragNode = null;
  }
  panning = false;
  panStart = null;
});

canvas.addEventListener('click', (e) => {
  const n = nodeAt(e.offsetX, e.offsetY);
  if (n && !n.isFocus) {
    vscode.postMessage({ type: 'navigate', iri: n.id });
  }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const n = nodeAt(e.offsetX, e.offsetY);
  if (n) {
    vscode.postMessage({ type: 'goToDefinition', iri: n.id });
  }
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  zoom = Math.max(0.2, Math.min(5, zoom * factor));
  draw();
}, { passive: false });
</script>
</body>
</html>`;
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
