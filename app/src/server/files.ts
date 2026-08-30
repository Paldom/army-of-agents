import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize, relative, resolve, sep } from 'node:path';

/**
 * The project file browser that Docs is built on.
 *
 * Breadth-first reading order is carried by DIRECTORY NAMING (00-, 10-, 20-…),
 * not by a bespoke index UI. There is no index abstraction here on purpose:
 * a file tree plus rendered markdown plus links that resolve is the whole
 * feature.
 */

export interface Entry {
  path: string;
  name: string;
  dir: boolean;
  size?: number;
  modified?: number;
}

const SKIP = new Set(['.git', 'node_modules', '.venv', 'dist', 'build', '.next', '__pycache__']);

/** Refuse anything that escapes the root. The browser is not a filesystem. */
export function safeJoin(root: string, rel: string): string | null {
  const target = resolve(root, normalize(rel).replace(/^([/\\])+/, ''));
  const r = resolve(root);
  if (target !== r && !target.startsWith(r + sep)) return null;
  return target;
}

export function tree(root: string, maxEntries = 4000): Entry[] {
  const out: Entry[] = [];
  const walk = (abs: string) => {
    if (out.length >= maxEntries) return;
    let items: string[];
    try {
      items = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of items.sort()) {
      if (name.startsWith('.') && name !== '.github') continue;
      if (SKIP.has(name)) continue;
      const full = join(abs, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(root, full);
      if (st.isDirectory()) {
        out.push({ path: rel, name, dir: true });
        walk(full);
      } else {
        out.push({ path: rel, name, dir: false, size: st.size, modified: st.mtimeMs });
      }
      if (out.length >= maxEntries) return;
    }
  };
  walk(resolve(root));
  return out;
}

export interface ReadResult {
  path: string;
  content: string;
  size: number;
  modified: number;
  language: string;
  readOnly: string | null;
}

/**
 * Two read-only rules, and both are true statements about the system rather
 * than UI preferences.
 */
export function readOnlyReason(rel: string): string | null {
  if (/^policies[/\\][^/\\]+\.ya?ml$/i.test(rel)) {
    return 'Owner-signed policy. Agents cannot edit this file; policy changes go through the owner-controlled signing workflow.';
  }
  if (/^hitl[/\\].*\.md$/i.test(rel)) {
    return 'Read-only historical record. This workspace replaced this file as the active human-in-the-loop channel.';
  }
  return null;
}

export function languageOf(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'json') return 'json';
  if (ext === 'py') return 'python';
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'js' || ext === 'mjs') return 'javascript';
  return 'text';
}

export function readFile(root: string, rel: string): ReadResult | null {
  const abs = safeJoin(root, rel);
  if (!abs) return null;
  let st;
  try {
    st = statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size > 2_000_000) {
    return {
      path: rel, content: `File is ${Math.round(st.size / 1024)} KB — too large to preview.`,
      size: st.size, modified: st.mtimeMs, language: 'text', readOnly: 'Too large to edit here.',
    };
  }
  return {
    path: rel,
    content: readFileSync(abs, 'utf8'),
    size: st.size,
    modified: st.mtimeMs,
    language: languageOf(rel),
    readOnly: readOnlyReason(rel),
  };
}

export function writeFile(root: string, rel: string, content: string): { ok: boolean; error?: string } {
  const reason = readOnlyReason(rel);
  if (reason) return { ok: false, error: reason };
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: 'path escapes the project root' };
  try {
    writeFileSync(abs, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * The paths relevant to one agent — its charter and its own docs subtree.
 * This is a POINTER into the browser, not a second documentation system.
 */
export function relevantTo(root: string, slug: string, docsRef: string | null): Entry[] {
  const all = tree(root);
  const hits = all.filter(
    (e) =>
      !e.dir &&
      (e.path.includes(`${sep}${slug}${sep}`) ||
        e.path.endsWith(`${sep}${slug}.md`) ||
        (docsRef ? e.path.startsWith(docsRef) : false)),
  );
  return hits.slice(0, 20);
}
