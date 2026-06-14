const HUES = [212, 168, 140, 96, 45, 28, 4, 330, 300, 270, 248, 190, 60, 14];

const OVERRIDE: Record<string, number> = {
  'Capability': 48, 'Product': 132, 'Resource': 28, 'Feature': 168,
  'Billing Subledger': 205, 'Solution': 104, 'FinancialStatement': 214,
  'Team': 330, 'Business Domain': 270, 'Artifact Type': 308,
  'Assembly Maturity Level': 190, 'Dataset': 212, 'Revenue stream': 140,
  'System': 270, 'Subledger': 28, 'Gate signal': 45, 'Job': 168,
  'Accounting period': 300, 'Accounting standard': 248, 'Customer': 120,
  'Process': 168, 'StandardOperatingProcedure': 28, 'SOXControl': 4,
  'Role': 212, 'DataObject': 190, 'Journey': 96, 'AccountingArea': 45,
  'RevenueStream': 140, 'GLAccount': 248, 'TaxCategory': 14, 'Period': 300,
  'Standard': 270, 'Subprocess': 270, 'Enterprise Process': 212,
  'Platform Layer': 190, 'Platform Capability': 96, 'Persona': 330,
  'Lifecycle Stage': 168, 'Deployment Package': 45, 'Deployment Artifact': 28,
  'Experiment': 104, 'Workstream': 60, 'Domain Primitive': 248,
};

function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function hueFor(type: string): number {
  if (OVERRIDE[type] != null) { return OVERRIDE[type]; }
  return HUES[hash(type) % HUES.length];
}

export interface TypeColorSet {
  dot: string;
  bg: string;
  border: string;
  text: string;
}

export function lightColors(type: string): TypeColorSet {
  const h = hueFor(type);
  return {
    dot: `hsl(${h} 58% 42%)`,
    bg: `hsl(${h} 70% 96.5%)`,
    border: `hsl(${h} 52% 80%)`,
    text: `hsl(${h} 55% 33%)`,
  };
}

export function darkColors(type: string): TypeColorSet {
  const h = hueFor(type);
  return {
    dot: `hsl(${h} 58% 62%)`,
    bg: `hsl(${h} 34% 15%)`,
    border: `hsl(${h} 34% 36%)`,
    text: `hsl(${h} 52% 72%)`,
  };
}

export function hueToThemeColor(hue: number): string {
  if (hue >= 340 || hue < 20) { return 'charts.red'; }
  if (hue < 50) { return 'charts.orange'; }
  if (hue < 80) { return 'charts.yellow'; }
  if (hue < 170) { return 'charts.green'; }
  if (hue < 260) { return 'charts.blue'; }
  return 'charts.purple';
}
