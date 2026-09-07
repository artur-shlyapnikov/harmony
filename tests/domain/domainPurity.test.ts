/**
 * Domain purity test (§3.3 architectural boundaries).
 *
 *  1. ONLY src/domain/theory/tonalAdapter.ts may import the 'tonal' package.
 *  2. No React / Redux / Tone / Dexie / DOM imports anywhere in src/domain.
 *  3. The src/domain internal import graph is acyclic (static imports,
 *     relative paths and @domain/* aliases resolved).
 */

import { describe, expect, it } from 'vitest';

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOMAIN_ROOT = fileURLToPath(new URL('../../src/domain', import.meta.url));

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function relative(file: string): string {
  return file.slice(DOMAIN_ROOT.length + 1);
}

function importSources(source: string): string[] {
  const sources: string[] = [];
  const patterns = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) sources.push(match[1]);
    }
  }
  return sources;
}

const FORBIDDEN_PREFIXES = [
  'react',
  'react-dom',
  'react-redux',
  '@reduxjs',
  'tone',
  'dexie',
];

describe('domain purity', () => {
  const files = listTsFiles(DOMAIN_ROOT);

  it('collects domain files (sanity check)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('only tonalAdapter.ts imports tonal', () => {
    const offenders = files
      .filter((file) =>
        importSources(readFileSync(file, 'utf8')).some(
          (source) => source === 'tonal' || source.startsWith('tonal/'),
        ),
      )
      .map(relative);
    expect(offenders).toEqual(['theory/tonalAdapter.ts']);
  });

  it('no React/Redux/Tone/Dexie/DOM imports anywhere in the domain', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const source of importSources(readFileSync(file, 'utf8'))) {
        const bare = source.split('/')[0] ?? source;
        if (
          FORBIDDEN_PREFIXES.includes(bare) ||
          bare === 'dom' ||
          source === 'jsdom'
        ) {
          offenders.push(`${relative(file)} -> ${source}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Resolves a static import specifier of `fromFile` to a domain-internal
 * module path (domain-relative, '.ts'-normalized). Returns null for bare
 * (external/package) specifiers and for paths leaving src/domain.
 */
function resolveDomainModule(fromFile: string, source: string): string | null {
  const base = source.startsWith('@domain/')
    ? join(DOMAIN_ROOT, source.slice('@domain/'.length))
    : source.startsWith('.')
      ? join(dirname(fromFile), source)
      : null;
  if (base === null) return null;
  const withExtension = base.endsWith('.ts') ? base : `${base}.ts`;
  const domainRelative = relative(withExtension);
  return domainRelative.startsWith('..') ? null : domainRelative;
}

/**
 * Walks the resolved import graph depth-first and returns one cycle as an
 * ordered list of domain-relative module paths (first entry === last), or
 * null when the graph is acyclic. Deterministic: nodes are visited in sorted
 * order, dependencies in source order.
 */
function findImportCycle(graph: Map<string, string[]>): string[] | null {
  const done = new Set<string>();
  const inProgress = new Set<string>();
  const path: string[] = [];
  const state: { cycle: string[] | null } = { cycle: null };

  const visit = (node: string): void => {
    if (state.cycle !== null || done.has(node)) return;
    if (inProgress.has(node)) {
      state.cycle = [...path.slice(path.indexOf(node)), node];
      return;
    }
    inProgress.add(node);
    path.push(node);
    for (const dep of graph.get(node) ?? []) visit(dep);
    path.pop();
    inProgress.delete(node);
    done.add(node);
  };

  for (const node of [...graph.keys()].sort()) visit(node);
  return state.cycle;
}

describe('domain acyclicity', () => {
  it('the internal import graph of src/domain is acyclic', () => {
    const graph = new Map<string, string[]>();
    for (const file of listTsFiles(DOMAIN_ROOT)) {
      graph.set(
        relative(file),
        importSources(readFileSync(file, 'utf8'))
          .map((source) => resolveDomainModule(file, source))
          .filter((dep): dep is string => dep !== null),
      );
    }

    const cycle = findImportCycle(graph);
    expect(cycle === null ? [] : `cycle: ${cycle.join(' -> ')}`).toEqual([]);
  });
});
