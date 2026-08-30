import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib';
import type { DerivedStatus, Tone } from '@/shared/api/types';
import { toneOf } from '@/shared/api/types';

/* Presentational only. These take no data and fetch nothing, so they compose
   anywhere and are testable without a provider. */

const button = cva(
  'inline-flex items-center gap-1.5 rounded-md border text-[13px] font-medium transition-colors ' +
    'disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        default: 'border-border bg-surface hover:bg-muted',
        primary: 'border-fg bg-fg text-surface hover:opacity-90',
        ghost: 'border-transparent hover:bg-muted',
        danger: 'border-fail/30 bg-fail-bg text-fail hover:bg-fail/10',
      },
      size: { sm: 'px-2.5 py-1', md: 'px-3 py-1.5', lg: 'px-4 py-2' },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export function Button({
  className, variant, size, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...props} />;
}

export function Card({
  className, tone, ...props
}: HTMLAttributes<HTMLDivElement> & { tone?: Tone | undefined }) {
  return (
    <div
      className={cn(
        'rounded-xl border bg-surface',
        tone === 'blocker' ? 'border-blocker-border' : 'border-border',
        className,
      )}
      {...props}
    />
  );
}

export const CardHead = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex items-center gap-3 border-b border-border px-4 py-3', className)} {...p} />
);
export const CardBody = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('px-4 py-3.5', className)} {...p} />
);
export const CardFoot = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5', className)} {...p} />
);

const TONE_CLASS: Record<Tone, string> = {
  blocker: 'text-blocker bg-blocker-bg border-blocker-border',
  working: 'text-working bg-working-bg border-working/20',
  fail: 'text-fail bg-fail-bg border-fail/25',
  quiet: 'text-muted-fg bg-muted border-border',
};

export function Chip({ tone = 'quiet', className, children }: { tone?: Tone | undefined; className?: string | undefined; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[11px] leading-none whitespace-nowrap', TONE_CLASS[tone], className)}>
      {children}
    </span>
  );
}

const DOT: Record<Tone, string> = {
  blocker: 'bg-blocker', working: 'bg-working', fail: 'bg-fail', quiet: 'bg-muted-fg/45',
};

/** Never colour alone: every dot ships with its label. */
export function StatusChip({ status }: { status: DerivedStatus }) {
  const tone = toneOf(status);
  return (
    <Chip tone={tone}>
      <span className={cn('size-1.5 rounded-full', DOT[tone])} aria-hidden />
      {status}
    </Chip>
  );
}

export const Mono = ({ className, ...p }: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('font-mono text-[12px] text-muted-fg', className)} {...p} />
);

export const Note = ({ className, ...p }: HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-[13px] leading-relaxed text-muted-fg', className)} {...p} />
);

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="py-16 text-center">
      <p className="text-muted-fg">{title}</p>
      {hint && <p className="mt-1.5 font-mono text-[12px] text-muted-fg/80">{hint}</p>}
    </div>
  );
}
