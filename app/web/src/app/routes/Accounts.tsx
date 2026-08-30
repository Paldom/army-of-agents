import { useState } from 'react';
import { useAccounts, useWorkspace } from '@/shared/api/queries';
import { api } from '@/shared/api/client';
import { Button, Card, CardBody, Chip, Mono, Note } from '@/components/ui/primitives';
import { when } from '@/shared/format';

export function Accounts() {
  const [search, setSearch] = useState('');
  const { data, refetch } = useAccounts(search);
  const { data: state } = useWorkspace();
  const lanes = state?.fleet.lanes ?? [];

  return (
    <>
      <h1>Accounts</h1>
      <p className="mb-5 mt-1.5 max-w-[72ch] text-muted-fg">
        Vendor lanes tell you what can run. Website accounts tell you which identity an agent may
        use. They are different records and share no credential material.
      </p>

      <Card className="mb-6">
        <CardBody>
          <b>Credential values never enter this view.</b>
          <Note className="mt-0.5">
            Each row confirms that a credential exists and names its OS keychain item.
            There is no value, no copy action and no reveal control.
          </Note>
        </CardBody>
      </Card>

      <h2 className="mb-3">Vendor lanes</h2>
      <Card className="mb-7 overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[12px] font-semibold text-muted-fg">
              <Th>Vendor</Th><Th>State</Th><Th>In use</Th><Th>Waiting</Th>
            </tr>
          </thead>
          <tbody>
            {lanes.map((l) => (
              <tr key={l.vendor} className="border-b border-border last:border-0">
                <Td><span className="font-mono">{l.vendor}</span></Td>
                <Td>
                  <Chip tone={l.exhausted ? 'fail' : 'working'}>{l.exhausted ? 'exhausted' : 'available'}</Chip>
                  {l.reason && <Mono className="ml-2">{l.reason}</Mono>}
                </Td>
                <Td><span className="font-mono">{l.inUse}/{l.maxLanes}</span></Td>
                <Td><span className="font-mono">{l.waiting}</span></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mb-3 flex items-start justify-between gap-4">
        <h2>Website accounts</h2>
        <Button variant="primary" onClick={async () => {
          const name = window.prompt('Dictionary name');
          if (!name) return;
          await api.addDictionary({ name, location: window.prompt('Where it lives') ?? '' });
          void refetch();
        }}>Add another dictionary</Button>
      </div>
      <Note className="mb-3">
        The merged list from every registered dictionary in central storage. Search and filters stay
        useful as this grows into hundreds of rows.
      </Note>

      <div className="mb-3 flex flex-wrap gap-2">
        {data?.dictionaries.map((d) => (
          <Chip key={d.id}>{d.name} · {d.rows} rows · {d.location}</Chip>
        ))}
      </div>

      <input
        type="search" value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder="Search platform, handle, agent or keychain reference"
        className="mb-3 w-full rounded-lg border border-border bg-surface px-3 py-2 text-[14px] outline-none focus:border-muted-fg/50"
      />

      <Card className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[12px] font-semibold text-muted-fg">
              <Th>Platform</Th><Th>Handle</Th><Th>Status</Th><Th>Allowed agents</Th>
              <Th>Last used</Th><Th>Credential</Th><Th>Dictionary</Th>
            </tr>
          </thead>
          <tbody>
            {data?.accounts.length ? data.accounts.map((r, i) => (
              <tr key={`${r.dictionary}-${r.platform}-${r.handle}-${i}`} className="border-b border-border last:border-0">
                <Td>{r.platform}</Td>
                <Td><span className="font-mono">{r.handle}</span></Td>
                <Td><Chip>{r.status}</Chip></Td>
                <Td><span className="font-mono">{r.allowedAgents.join(' ')}</span></Td>
                <Td><span className="font-mono">{r.lastUsedAt ? when(r.lastUsedAt).slice(0, 10) : '—'}</span></Td>
                <Td><span className="font-mono">{r.hasCredential ? r.keychainRef : '—'}</span></Td>
                <Td><span className="font-mono">{r.dictionary}</span></Td>
              </tr>
            )) : (
              <tr><td colSpan={7} className="py-10 text-center text-muted-fg">No accounts registered.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

const Th = ({ children }: { children: React.ReactNode }) => <th className="px-3 py-2.5 font-semibold">{children}</th>;
const Td = ({ children }: { children: React.ReactNode }) => <td className="px-3 py-2.5">{children}</td>;
