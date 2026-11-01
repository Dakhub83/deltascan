import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';

/** Gap between the menu and the viewport edge. */
const VIEWPORT_MARGIN = 8;

interface PopoverProps {
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}

/**
 * Minimal click-to-open popover. The menu is portalled to the trigger's own document body:
 * dockview panels clip their content, and pop-out windows have their own document.
 */
export function Popover({ trigger, children, align = 'left', className }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) return setStyle(null);
    const rect = ref.current.getBoundingClientRect();
    const win = ref.current.ownerDocument.defaultView ?? window;
    const top = rect.bottom + 4;
    setStyle({
      top,
      maxHeight: win.innerHeight - top - VIEWPORT_MARGIN,
      ...(align === 'right' ? { right: win.innerWidth - rect.right } : { left: rect.left }),
    });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const doc = ref.current?.ownerDocument ?? document;
    const win = doc.defaultView ?? window;
    const close = () => setOpen(false);
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !menuRef.current?.contains(target)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    // A fixed-position menu would drift away from its trigger, so close instead.
    const onScroll = (e: Event) => !menuRef.current?.contains(e.target as Node) && close();
    doc.addEventListener('mousedown', onDown);
    doc.addEventListener('keydown', onKey);
    doc.addEventListener('scroll', onScroll, true);
    win.addEventListener('resize', close);
    return () => {
      doc.removeEventListener('mousedown', onDown);
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('scroll', onScroll, true);
      win.removeEventListener('resize', close);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {open &&
        style &&
        ref.current &&
        createPortal(
          <div
            ref={menuRef}
            style={style}
            className={clsx(
              'fixed z-50 min-w-48 overflow-y-auto overscroll-contain rounded-lg border border-line-strong bg-raised p-1 shadow-2xl shadow-black/60',
              className,
            )}
          >
            {children(() => setOpen(false))}
          </div>,
          ref.current.ownerDocument.body,
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
