import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';

interface PopoverProps {
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

/**
 * Minimal click-to-open popover. Listens on the element's own document so it keeps
 * working inside dockview pop-out windows.
 */
export function Popover({ trigger, children, align = 'left', className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const doc = ref.current?.ownerDocument ?? document;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    doc.addEventListener('mousedown', onDown);
    doc.addEventListener('keydown', onKey);
    return () => {
      doc.removeEventListener('mousedown', onDown);
      doc.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {open && (
        <div
          className={clsx(
            'absolute top-full z-50 mt-1 min-w-48 rounded-lg border border-line-strong bg-raised p-1 shadow-2xl shadow-black/60',
            align === 'right' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  active,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-hover',
        active ? 'text-fg' : 'text-dim hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted uppercase">{children}</div>;
}

export function IconButton({
  children,
  onClick,
  title,
  active,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  title: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={clsx(
        'grid size-6 place-items-center rounded-md transition-colors hover:bg-hover',
        active ? 'text-accent' : 'text-muted hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  );
}
