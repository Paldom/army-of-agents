import { useMemo, useState } from 'react';
import { useAgentDocs, useFile, useFiles, useSaveFile } from '@/shared/api/queries';
import { useUi } from '@/shared/store/ui';
import { Markdown } from '@/components/Markdown';
import { Button, Card, CardBody, CardHead, Empty, Mono, Note } from '@/components/ui/primitives';
import { bytes, when } from '@/shared/format';
import { cn } from '@/lib';

export function Docs() {
  const { data: tree } = useFiles();
  const { filePath, openFile, agent } = useUi();
  const { data: file } = useFile(filePath);
  const { data: relevant } = useAgentDocs(agent);
  const save = useSaveFile();
  const [q, setQ] = useState('');
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<string | null>(null);

  const entries = tree?.entries ?? [];
  const visible = useMemo(() => {
    if (q) return entries.filter((e) => !e.dir && e.path.toLowerCase().includes(q.toLowerCase())).slice(0, 300);
    const onPath = new Set<string>();
    if (filePath) {
      const parts = filePath.split('/');
      for (let i = 1; i < parts.length; i++) onPath.add(parts.slice(0, i).join('/'));
    }
    return entries.filter((e) => {
      const parent = e.path.split('/').slice(0, -1).join('/');
      return parent === '' || onPath.has(parent) || openDirs.has(parent);
    });
  }, [entries, q, filePath, openDirs]);

  const resolve = (href: string) => {
    const base = filePath?.split('/').slice(0, -1) ?? [];
    const stack: string[] = [];
    for (const p of [...base, ...href.split('/')]) {
      if (p === '..') stack.pop();
      else if (p && p !== '.') stack.push(p);
    }
    openFile(stack.join('/'));
  };

  return (
    <>
      <h1>Project files</h1>
      <p className="mb-5 mt-1.5 max-w-[72ch] text-muted-fg">
        Browse the project as it is stored. Directory names carry the reading order — broad first,
        then deeper — and links inside Markdown open here.
      </p>

      <div className="grid items-start gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="max-h-[74vh] overflow-auto p-2" data-testid="file-tree">
          {relevant?.relevant.length ? (
            <div className="mb-2 border-b border-border pb-2">
              <div className="px-1.5 py-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-fg">
                Relevant to {agent}
              </div>
              {relevant.relevant.map((r) => (
                <TreeButton key={r.path} label={r.path} active={filePath === r.path} onClick={() => openFile(r.path)} />
              ))}
            </div>
          ) : null}
          <input
            type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search paths…"
            className="mb-2 w-full rounded-md border border-border px-2.5 py-1.5 text-[13px] outline-none focus:border-muted-fg/50"
          />
          {visible.map((e) => (
            <TreeButton
              key={e.path}
              label={e.name}
              depth={q ? 0 : e.path.split('/').length - 1}
              dir={e.dir}
              active={filePath === e.path}
              onClick={() => {
                if (!e.dir) return openFile(e.path);
                setOpenDirs((s) => {
                  const n = new Set(s);
                  n.has(e.path) ? n.delete(e.path) : n.add(e.path);
                  return n;
                });
              }}
            />
          ))}
        </Card>

        <Card>
          {!file ? <Empty title="Select a file." /> : (
            <>
              <CardHead>
                <Mono className="text-fg">{file.path}</Mono>
                <Mono className="ml-auto">{bytes(file.size)} · {when(file.modified)}</Mono>
                {!file.readOnly && (
                  draft === null
                    ? <Button size="sm" onClick={() => setDraft(file.content)}>Edit</Button>
                    : <>
                        <Button size="sm" variant="primary"
                          onClick={() => { save.mutate({ path: file.path, content: draft }); setDraft(null); }}>Save</Button>
                        <Button size="sm" onClick={() => setDraft(null)}>Cancel</Button>
                      </>
                )}
              </CardHead>
              <CardBody>
                {file.readOnly && (
                  <div className="mb-3 rounded-lg border border-fail/25 bg-fail-bg px-3.5 py-2.5 text-[13px] text-fail">
                    <b>Read-only.</b> {file.readOnly}
                  </div>
                )}
                {draft !== null ? (
                  <>
                    <textarea value={draft} onChange={(e) => setDraft(e.target.value)}
                      className="min-h-[50vh] w-full rounded-lg border border-border p-3 font-mono text-[13px] outline-none" />
                    <Note className="mt-1.5">Unsaved changes.</Note>
                  </>
                ) : file.language === 'markdown'
                  ? <Markdown src={file.content} onNavigate={resolve} />
                  : <pre className="overflow-auto rounded-lg bg-muted p-3"><code>{file.content}</code></pre>}
              </CardBody>
            </>
          )}
        </Card>
      </div>
    </>
  );
}

function TreeButton({ label, depth = 0, dir, active, onClick }: {
  label: string; depth?: number; dir?: boolean; active?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      style={{ paddingLeft: 6 + depth * 12 }}
      className={cn('block w-full truncate rounded px-1.5 py-1 text-left text-[13px]',
        active ? 'bg-muted font-semibold' : 'hover:bg-muted/60')}
    >
      {dir ? '▸ ' : ''}{label}
    </button>
  );
}
