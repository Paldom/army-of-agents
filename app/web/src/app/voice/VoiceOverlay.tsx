import { useEffect, useRef, useState } from 'react';
import { AudioLines, X } from 'lucide-react';
import { useUi } from '@/shared/store/ui';
import { useWorkspace } from '@/shared/api/queries';
import { api } from '@/shared/api/client';
import { Button, Card, CardBody, Chip, Note } from '@/components/ui/primitives';

type VoiceState = 'idle' | 'listening' | 'transcribing' | 'confirming' | 'speaking' | 'error';

/**
 * Voice is a mode over the whole workspace, not a feature of one screen.
 *
 * Two rules it must never break:
 *  - nothing that changes state happens without an explicit confirm step, because
 *    a mis-transcription must not be able to approve anything;
 *  - a spoken ordinal binds to a FROZEN SNAPSHOT of immutable ids. Agent lists
 *    sort by activity, so "answer the second one" can otherwise bind to a row
 *    that moved between hearing it and acting.
 */
export function VoiceOverlay() {
  const { voiceOpen, setVoice, setView, openAgent } = useUi();
  const { data } = useWorkspace();
  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState('');
  const [pending, setPending] = useState<{ label: string; run: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Frozen at the moment we start listening; invalidated by any state change. */
  const snapshot = useRef<Array<{ askId: string; agent: string }>>([]);
  const recognition = useRef<unknown>(null);

  useEffect(() => {
    if (!voiceOpen) return;
    snapshot.current = (data?.needsYou ?? []).map((q) => ({ askId: q.askId, agent: q.agent }));
  }, [voiceOpen, data]);

  if (!voiceOpen) return null;

  const start = async () => {
    setError(null);
    const SR = (window as unknown as { webkitSpeechRecognition?: new () => never; SpeechRecognition?: new () => never });
    const Ctor = SR.SpeechRecognition ?? SR.webkitSpeechRecognition;
    if (!Ctor) {
      // ElevenLabs owns the realtime edge; the browser API is the local fallback.
      const t = await api.voiceToken().catch(() => null);
      setError(t?.error ?? 'No speech input available. Set ELEVENLABS_API_KEY for the hosted voice edge.');
      setState('error');
      return;
    }
    const rec = new (Ctor as unknown as new () => {
      lang: string; interimResults: boolean; continuous: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onerror: () => void; onend: () => void; start: () => void; stop: () => void;
    })();
    recognition.current = rec;
    rec.lang = 'en-GB';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      const said = Array.from({ length: e.results.length }, (_, i) => e.results[i]![0]!.transcript).join(' ');
      setTranscript(said);
      setState('transcribing');
    };
    rec.onerror = () => { setError('Could not hear that.'); setState('error'); };
    rec.onend = () => interpret();
    setState('listening');
    rec.start();
  };

  const interpret = () => {
    const said = transcript.toLowerCase().trim();
    if (!said) { setState('idle'); return; }

    for (const [word, dest] of [['needs', 'needs'], ['orchestrator', 'orchestrator'], ['backlog', 'backlog'],
      ['accounts', 'accounts'], ['docs', 'docs'], ['status', 'status']] as const) {
      if (said.includes(word)) {
        // Navigation is not a state change; it needs no confirmation.
        setView(dest);
        setState('idle');
        return;
      }
    }

    const ordinal = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\b/.exec(said);
    if (ordinal) {
      const idx = ['first', '1st', 'second', '2nd', 'third', '3rd', 'fourth', '4th', 'fifth', '5th']
        .indexOf(ordinal[1]!) >> 1;
      const frozen = snapshot.current[idx];
      const live = (data?.needsYou ?? []).map((q) => q.askId);
      const stillThere = frozen && live[idx] === frozen.askId;
      if (!frozen) { setError('There is no such item.'); setState('error'); return; }
      if (!stillThere) {
        setError('That list moved while you were speaking. Say it again and I will re-read it.');
        setState('error');
        return;
      }
      setPending({
        label: `Open ${frozen.agent}'s ask (${ordinal[1]})`,
        run: () => { openAgent(frozen.agent); setView('needs'); },
      });
      setState('confirming');
      return;
    }
    setError('I only navigate and open things by voice. Answering still needs a click.');
    setState('error');
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-5">
      <Card className="w-full max-w-[560px] shadow-lg">
        <CardBody>
          <div className="mb-3 flex items-center gap-2.5">
            <AudioLines size={18} className={state === 'listening' ? 'text-blocker' : 'text-muted-fg'} />
            <Chip tone={state === 'listening' ? 'blocker' : state === 'error' ? 'fail' : 'quiet'}>{state}</Chip>
            {state === 'listening' && <span className="text-[13px] text-blocker">microphone live</span>}
            <button className="ml-auto text-muted-fg hover:text-fg" onClick={() => setVoice(false)} aria-label="Close voice">
              <X size={17} />
            </button>
          </div>

          {/* The transcript is always visible: you see what was heard before anything acts on it. */}
          <div className="min-h-[46px] rounded-lg border border-border bg-muted px-3 py-2.5 text-[14px]">
            {transcript || <span className="text-muted-fg">Say “open backlog”, “show status”, or “the second one”.</span>}
          </div>

          {error && <Note className="mt-2 text-fail">{error}</Note>}

          {state === 'confirming' && pending ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[14px]">{pending.label}</span>
              <Button size="sm" variant="primary" className="ml-auto"
                onClick={() => { pending.run(); setPending(null); setState('idle'); }}>Confirm</Button>
              <Button size="sm" onClick={() => { setPending(null); setState('idle'); }}>Cancel</Button>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="primary" onClick={start} disabled={state === 'listening'}>
                {state === 'listening' ? 'Listening…' : 'Push to talk'}
              </Button>
              <Note className="ml-1">
                Voice navigates and reads. Answering an ask always needs an explicit confirmation,
                and never a money-critical verb.
              </Note>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
