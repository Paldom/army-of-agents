import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { type Db, appendMessage, emit, now, tx } from '../store/db.ts';
import { createAgent, getAgentBySlug } from '../supervisor/repo.ts';
import { addBacklogItem, setChannels } from '../server/api.ts';
import { ask } from '../supervisor/hitl.ts';
import { DEFAULT_CONTINUOUS, type WakePolicy } from '../supervisor/wake.ts';

/**
 * Import an existing file-based agent system into the store.
 *
 * READ-ONLY BY CONSTRUCTION. Nothing here opens a file for writing in the
 * workload. Observation earns trust and cannot break a running system, so the
 * first integration must be incapable of damaging it — not merely careful.
 *
 * The descriptor says where things are; nothing about any particular project is
 * hardcoded here.
 */

export interface Descriptor {
  /** Absolute path to the workload. */
  root: string;
  /** A YAML roster of agents. */
  roster?: {
    path: string;
    /** Key under which the agent list lives (default: "agents"). */
    listKey?: string;
    /** Field names, for rosters that spell them differently. */
    fields?: { name?: string; division?: string; status?: string; charter?: string; cadence?: string };
    /** Roster status values that mean "run this now". Everything else imports as DRAFT. */
    activeValues?: string[];
  };
  /** Owner-facing question queue: numbered blocks with a status. */
  outbox?: { path: string; openStatuses?: string[] };
  /** Standing decisions grouped under priority headings. */
  backlog?: { path: string };
  /** Append-only decision record, imported as history. */
  decisions?: { path: string };
  /** Rolling digest directory; newest entries import as reports. */
  digest?: { dir: string; limit?: number };
}

export interface ImportReport {
  agents: { imported: number; active: number; draft: number; skipped: string[] };
  channels: number;
  charters: number;
  asks: number;
  backlog: number;
  reports: number;
  /** Anything the descriptor pointed at that was not there. */
  missing: string[];
  /** Stated plainly: this import wrote nothing to the workload. */
  wroteToWorkload: false;
}

const slugify = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

function readIfPresent(root: string, rel: string, missing: string[]): string | null {
  const abs = join(root, rel);
  if (!existsSync(abs)) {
    missing.push(rel);
    return null;
  }
  return readFileSync(abs, 'utf8');
}

/**
 * Cadence prose maps to a wake policy. Deliberately conservative: anything not
 * clearly continuous imports as manual, because starting an unfamiliar agent on
 * a tight loop is how an import becomes an incident.
 */
export function wakeFromCadence(cadence: string | undefined): WakePolicy {
  const c = (cadence ?? '').toLowerCase();
  if (/continuous|daemon|stream/.test(c)) return DEFAULT_CONTINUOUS;
  if (/\b(\d+)\s*min/.test(c)) {
    const m = Number(/\b(\d+)\s*min/.exec(c)![1]);
    return { kind: 'schedule', everyMs: m * 60_000 };
  }
  if (/hourly|per hour|1h/.test(c)) return { kind: 'schedule', everyMs: 3_600_000 };
  if (/daily|per day/.test(c)) return { kind: 'schedule', everyMs: 86_400_000 };
  if (/weekly/.test(c)) return { kind: 'schedule', everyMs: 7 * 86_400_000 };
  if (/event|on request|on friction/.test(c)) return { kind: 'on_message' };
  return { kind: 'manual' };
}

/** Numbered owner-facing blocks: `## [TAG-0001] Title — status: OPEN`. */
export function parseOutbox(
  md: string,
  openStatuses: string[],
): Array<{ ref: string; title: string; status: string; body: string }> {
  const out: Array<{ ref: string; title: string; status: string; body: string }> = [];
  const re = /^##\s*\[([^\]]+)\]\s*(.+?)\s*[—-]\s*status:\s*([A-Za-z_]+)\s*$/gm;
  const marks: Array<{ ref: string; title: string; status: string; at: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    marks.push({ ref: m[1]!, title: m[2]!, status: m[3]!.toUpperCase(), at: re.lastIndex, end: m.index });
  }
  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i]!;
    const body = md.slice(cur.at, marks[i + 1]?.end ?? md.length).trim();
    if (openStatuses.includes(cur.status)) {
      out.push({ ref: cur.ref, title: cur.title, status: cur.status, body });
    }
  }
  return out;
}

/** `## Priority N — rationale` followed by `1. **Title**. body` items. */
export function parseBacklog(
  md: string,
): Array<{ tier: number; rationale: string; title: string; body: string }> {
  const out: Array<{ tier: number; rationale: string; title: string; body: string }> = [];
  const sections = md.split(/^##\s+/m).slice(1);
  for (const sec of sections) {
    const head = /^Priority\s+(\d+)\s*[—-]?\s*(.*)$/m.exec(sec.split('\n')[0] ?? '');
    if (!head) continue;
    const tier = Number(head[1]);
    const rationale = (head[2] ?? '').trim();
    const itemRe = /^\d+\.\s+\*\*(.+?)\*\*\.?\s*([\s\S]*?)(?=^\d+\.\s+\*\*|\n##|\z)/gm;
    let it: RegExpExecArray | null;
    while ((it = itemRe.exec(sec)) !== null) {
      out.push({ tier, rationale, title: it[1]!.trim(), body: it[2]!.trim().replace(/\s+/g, ' ') });
    }
  }
  return out;
}

export function runImport(db: Db, d: Descriptor): ImportReport {
  const report: ImportReport = {
    agents: { imported: 0, active: 0, draft: 0, skipped: [] },
    channels: 0, charters: 0, asks: 0, backlog: 0, reports: 0,
    missing: [], wroteToWorkload: false,
  };

  return tx(db, () => {
    // ── roster ──────────────────────────────────────────────────────────────
    const divisions = new Map<string, string[]>();
    if (d.roster) {
      const raw = readIfPresent(d.root, d.roster.path, report.missing);
      if (raw) {
        const doc = parseYaml(raw) as Record<string, unknown>;
        const list = (doc[d.roster.listKey ?? 'agents'] ?? []) as Array<Record<string, unknown>>;
        const f = d.roster.fields ?? {};
        const activeValues = (d.roster.activeValues ?? ['active']).map((s) => s.toLowerCase());

        for (const entry of list) {
          const name = String(entry[f.name ?? 'name'] ?? '');
          if (!name) continue;
          const slug = slugify(name);
          if (getAgentBySlug(db, slug)) {
            report.agents.skipped.push(slug);
            continue;
          }
          const division = String(entry[f.division ?? 'division'] ?? 'general');
          const rosterStatus = String(entry[f.status ?? 'status'] ?? '').toLowerCase();
          const isActive = activeValues.some((v) => rosterStatus.startsWith(v));
          const charterRel = entry[f.charter ?? 'charter'] as string | undefined;
          const cadence = entry[f.cadence ?? 'cadence'] as string | undefined;

          // The charter IS the contract: it becomes the persisted system prompt.
          let persona = '';
          if (charterRel && existsSync(join(d.root, charterRel))) {
            persona = readFileSync(join(d.root, charterRel), 'utf8');
            report.charters++;
          }

          createAgent(db, {
            slug,
            displayName: name,
            title: division,
            persona,
            mission: firstMission(persona),
            wake: wakeFromCadence(cadence),
            createdBy: 'import',
            // Anything not clearly active imports as DRAFT. An import must not
            // start unfamiliar agents; a human activates them.
            status: isActive ? 'ACTIVE' : 'DRAFT',
            ...(charterRel ? { docsRef: dirname(charterRel) } : {}),
          });
          report.agents.imported++;
          isActive ? report.agents.active++ : report.agents.draft++;
          divisions.set(division, [...(divisions.get(division) ?? []), slug]);
        }

        // Divisions become channels. Channels are data, so this is just a row.
        setChannels(db, [...divisions].map(([name, members]) => ({ name, members })));
        report.channels = divisions.size;
      }
    }

    const anyAgent = (): string | null => {
      const row = db.prepare('SELECT id FROM agents ORDER BY created_at LIMIT 1').get() as
        | { id: string } | undefined;
      return row?.id ?? null;
    };

    // ── open questions ──────────────────────────────────────────────────────
    if (d.outbox) {
      const raw = readIfPresent(d.root, d.outbox.path, report.missing);
      if (raw) {
        const open = parseOutbox(raw, d.outbox.openStatuses ?? ['OPEN', 'PROPOSED']);
        const orch = getAgentBySlug(db, 'orchestrator');
        const target = orch?.id ?? anyAgent();
        if (target) {
          for (const item of open) {
            ask(db, {
              agentId: target,
              prompt: `[${item.ref}] ${item.title}`,
              evidence: [{ source: d.outbox.path, quote: item.body.slice(0, 500) }],
              imported: true,
            });
            report.asks++;
          }
        }
      }
    }

    // ── standing decisions ──────────────────────────────────────────────────
    if (d.backlog) {
      const raw = readIfPresent(d.root, d.backlog.path, report.missing);
      if (raw) {
        for (const item of parseBacklog(raw)) {
          addBacklogItem(db, {
            title: item.title,
            question: item.body || item.title,
            rationale: item.rationale,
            tier: item.tier,
            raisedBy: 'import',
          });
          report.backlog++;
        }
      }
    }

    // ── history ─────────────────────────────────────────────────────────────
    const orchId = getAgentBySlug(db, 'orchestrator')?.id ?? anyAgent();
    if (d.decisions && orchId) {
      const raw = readIfPresent(d.root, d.decisions.path, report.missing);
      if (raw && raw.trim()) {
        appendMessage(db, {
          agentId: orchId, kind: 'event', author: 'import',
          body: `Imported decision log (${d.decisions.path}), ${raw.split('\n').length} lines. Read-only history.`,
        });
      }
    }
    if (d.digest && orchId) {
      const dir = join(d.root, d.digest.dir);
      if (!existsSync(dir)) report.missing.push(d.digest.dir);
      else {
        const files = readdirSync(dir)
          // A dated name, not merely a digit somewhere: `/\d/` matched
          // `L0-TEMPLATE.md`, which then sorted last and became the newest
          // "report" the workspace showed for the whole fleet.
          .filter((f) => f.endsWith('.md') && /\d{4}-\d{2}-\d{2}/.test(f))
          .sort()
          .slice(-(d.digest.limit ?? 5));
        for (const f of files) {
          const body = readFileSync(join(dir, f), 'utf8');
          appendMessage(db, {
            agentId: orchId, kind: 'report', author: 'import',
            body: `${f}: ${firstLine(body)}`,
            meta: { source: relative(d.root, join(dir, f)) },
          });
          report.reports++;
        }
      }
    }

    emit(db, 'workload.imported', 'import', {
      agents: report.agents.imported, asks: report.asks, backlog: report.backlog,
    });
    return report;
  });
}

function firstMission(charter: string): string {
  const m = /\*\*Mission\.?\*\*\s*([\s\S]*?)(?:\n\n|\*\*)/.exec(charter);
  return m ? m[1]!.trim().replace(/\s+/g, ' ').slice(0, 400) : '';
}

function firstLine(md: string): string {
  for (const l of md.split('\n')) {
    const t = l.replace(/^#+\s*/, '').trim();
    if (t && !t.startsWith('<!--')) return t.slice(0, 160);
  }
  return '(empty)';
}

export { statSync, basename };
