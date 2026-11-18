import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * A keyboard or trackpad needs to see where it is. The ring is the accent colour
 * lifted clear of the control so it reads on filled and outlined buttons alike.
 */
export const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-paper-raised';

export function Button({
  variant = 'secondary',
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: ReactNode }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 h-10 text-[14px] font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none whitespace-nowrap';
  const focus = FOCUS_RING;
  const styles: Record<Variant, string> = {
    primary: 'bg-accent text-paper-raised hover:bg-accent-strong',
    secondary: 'bg-paper-raised border border-line text-ink hover:bg-paper-sunken',
    ghost: 'text-ink-soft hover:bg-paper-sunken',
    danger: 'bg-danger text-white hover:brightness-95',
  };
  return (
    <button type="button" className={cx(base, focus, styles[variant], className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  active,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-11 w-11 items-center justify-center rounded-lg transition-colors',
        FOCUS_RING,
        active ? 'bg-accent text-paper-raised' : 'text-ink-soft hover:bg-paper-sunken',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const lastOutsideRef = useRef<HTMLElement | null>(null);

  // Remember what held focus before the sheet opened. Reading it while opening
  // is too late: a field inside the sheet that asks for `autoFocus` takes focus
  // during the same commit, so the sheet would "restore" focus to a control it
  // is about to unmount. The check is by ancestor rather than by ref because the
  // ref is not attached yet at that exact moment.
  useEffect(() => {
    const track = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.isConnected || target.closest('[role="dialog"]')) return;
      lastOutsideRef.current = target;
    };
    document.addEventListener('focusin', track, true);
    return () => document.removeEventListener('focusin', track, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    const active = document.activeElement as HTMLElement | null;
    const insideSheet = Boolean(active && panel?.contains(active));
    restoreRef.current =
      insideSheet || !active || active === document.body ? lastOutsideRef.current : active;
    // A field that asked for `autoFocus` keeps it; otherwise the sheet itself
    // takes focus, so a screen reader announces it without raising the keyboard.
    if (panel && !insideSheet) panel.focus({ preventScroll: true });
    return () => restoreRef.current?.focus?.({ preventScroll: true });
  }, [open]);

  /** `aria-modal` promises the page behind is out of reach; make Tab keep it so. */
  function trapTab(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [
      ...panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => element.getClientRects().length > 0);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!first || !last) {
      event.preventDefault();
      panel.focus({ preventScroll: true });
      return;
    }
    if (!active || !panel.contains(active) || active === panel) return;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/25 p-0 backdrop-blur-[2px] sm:items-center sm:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
        className={cx(
          'animate-in w-full overflow-hidden rounded-t-2xl border border-line bg-paper-raised shadow-float outline-none sm:rounded-2xl',
          wide ? 'sm:max-w-2xl' : 'sm:max-w-md',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id={titleId} className="font-serif text-[19px] leading-tight text-ink">
              {title}
            </h2>
            {description && <p className="mt-1 text-[13px] text-ink-muted">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mr-2 h-9 w-9">
            <X size={18} strokeWidth={1.75} />
          </IconButton>
        </div>
        {children && (
          <div className="thin-scroll max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        )}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3 pb-[max(0.75rem,var(--safe-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] leading-relaxed text-ink-muted">{hint}</span>}
    </label>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cx(
        'h-11 w-full rounded-lg border border-line bg-paper px-3 text-[15px] text-ink outline-none placeholder:text-ink-faint transition-shadow focus:border-accent focus:ring-2 focus:ring-accent/25',
        props.className,
      )}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div>
        <div className="text-[15px] text-ink">{label}</div>
        {description && <div className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={cx(
          'mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors',
          FOCUS_RING,
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-paper-sunken',
        )}
      >
        <span
          className={cx(
            'block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
            checked ? 'translate-x-[22px]' : 'translate-x-[3px]',
          )}
        />
      </button>
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-paper-sunken p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={cx(
            'min-h-[36px] rounded-md px-3 py-1.5 text-[13px] transition-colors',
            FOCUS_RING,
            value === option.value
              ? 'bg-paper-raised text-ink shadow-sm'
              : 'text-ink-muted hover:text-ink',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-block h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-accent',
        className,
      )}
      aria-hidden
    />
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line-strong bg-paper-raised/60 px-6 py-16 text-center">
      <h3 className="font-serif text-[20px] text-ink">{title}</h3>
      <p className="mt-2 max-w-sm text-[13.5px] leading-relaxed text-ink-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ScreenHeader({
  title,
  subtitle,
  onBack,
  actions,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  actions?: ReactNode;
}) {
  return (
    <header className="safe-px flex shrink-0 flex-wrap items-center gap-3 border-b border-line bg-paper/90 py-3 pt-[max(0.75rem,var(--safe-top))] backdrop-blur">
      {onBack && (
        <Button variant="ghost" onClick={onBack} className="-ml-2 px-2" aria-label="Back">
          <span className="text-[15px]">Back</span>
        </Button>
      )}
      {/* A minimum width for the title block makes the actions wrap onto their own
          line on a phone, instead of squeezing the title and subtitle into an
          ellipsis. */}
      <div className="min-w-[10rem] flex-1">
        {/* Two lines rather than an ellipsis: a default title such as "Untitled
            notebook" was already cut to "Untitled not…" on a 390 px screen. */}
        <h1 className="line-clamp-2 break-words font-serif text-[22px] leading-tight text-ink">{title}</h1>
        {subtitle && <p className="line-clamp-2 break-words text-[12.5px] text-ink-muted">{subtitle}</p>}
      </div>
      <div className="ml-auto flex items-center gap-1.5">{actions}</div>
    </header>
  );
}
