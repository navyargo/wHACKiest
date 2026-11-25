"use client";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, Inbox, Loader2, RotateCw, X } from "lucide-react";
import React, { createContext, useCallback, useContext, useId, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-teal-700 text-white hover:bg-teal-800 disabled:bg-slate-300 disabled:text-slate-700",
  secondary: "border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:bg-slate-100 disabled:text-slate-500",
  ghost: "text-slate-700 hover:bg-slate-100 disabled:text-slate-500",
  danger: "border border-red-300 bg-white text-red-700 hover:bg-red-50 disabled:bg-slate-100 disabled:text-slate-500",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: "sm" | "md";
  loading?: boolean;
  disabledReason?: string | null;
}

/** Button. When `disabledReason` is set it renders disabled with an accessible tooltip explaining why. Minimum 44x44px touch target. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, disabledReason, className, children, ...rest },
  ref,
) {
  const id = useId();
  const disabled = rest.disabled || !!disabledReason || loading;
  const btn = (
    <button
      {...rest}
      ref={ref}
      disabled={disabled}
      aria-describedby={disabledReason ? id : rest["aria-describedby"]}
      className={cx(
        "inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1.5 rounded-md font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 disabled:cursor-not-allowed",
        size === "sm" ? "px-3 py-2 text-sm" : "px-4 py-2.5 text-[15px]",
        VARIANTS[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </button>
  );
  if (!disabledReason) return btn;
  return (
    <span className="group relative inline-flex" tabIndex={0} aria-describedby={id}>
      {btn}
      <span id={id} role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-max max-w-[16rem] -translate-x-1/2 rounded bg-slate-900 px-2.5 py-1.5 text-xs text-white opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
        {disabledReason}
      </span>
    </span>
  );
});

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={cx("rounded-lg border border-slate-200 bg-white", className)}>
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <div className="mt-1 text-slate-600">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Skeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cx("space-y-3", className)} role="status" aria-busy="true" aria-label="Loading content">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" />
      ))}
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div role="status" className="flex flex-col items-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <div className="mb-2 text-slate-500">{icon ?? <Inbox className="h-8 w-8" aria-hidden />}</div>
      <p className="font-medium text-slate-800">{title}</p>
      {children && <div className="mt-1 text-sm text-slate-600">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" aria-live="assertive" className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-900">
      <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden />
      <span className="flex-1 font-medium">{(error as Error)?.message ?? "Couldn't load this."}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          <RotateCw className="h-4 w-4" aria-hidden /> Retry
        </Button>
      )}
    </div>
  );
}

/** Loading / error / empty / content switch used by every screen. */
export function Async<T>({ data, error, isLoading, retry, empty, children, rows }: { data: T | undefined; error: unknown; isLoading: boolean; retry: () => void; empty?: (d: T) => ReactNode | null; children: (d: T) => ReactNode; rows?: number }) {
  if (error && !data) return <ErrorState error={error} onRetry={retry} />;
  if (isLoading || data === undefined) return <Skeleton rows={rows} />;
  const e = empty?.(data);
  return <>{e ?? children(data)}</>;
}

export function Modal({ open, onOpenChange, title, description, children, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
        <Dialog.Content className={cx("fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg bg-white p-5 shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-700", wide ? "max-w-3xl" : "max-w-lg")}>
          <div className="mb-3 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold text-slate-900">{title}</Dialog.Title>
            <Dialog.Close className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-700" aria-label="Close dialog">
              <X className="h-5 w-5" aria-hidden />
            </Dialog.Close>
          </div>
          {description ? <Dialog.Description className="mb-3 text-slate-600">{description}</Dialog.Description> : <Dialog.Description className="sr-only">{title}</Dialog.Description>}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Drawer({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-slate-900/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl overflow-y-auto bg-white p-5 shadow-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-700">
          <div className="mb-4 flex items-start justify-between gap-4">
            <Dialog.Title className="text-lg font-semibold text-slate-900">{title}</Dialog.Title>
            <Dialog.Close className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-2 text-slate-600 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-700" aria-label="Close drawer">
              <X className="h-5 w-5" aria-hidden />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{title}</Dialog.Description>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Field({ label, hint, error, id: propId, className, children }: { label: string; hint?: string; error?: string; id?: string; className?: string; children: ReactNode }) {
  const generatedId = useId();
  const id = propId ?? generatedId;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  let inputContent = children;
  if (React.isValidElement(children)) {
    const existingDescribedBy = (children.props as { "aria-describedby"?: string })["aria-describedby"];
    const mergedDescribedBy = existingDescribedBy ? `${existingDescribedBy} ${describedBy}`.trim() : describedBy;
    inputContent = React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      id: (children.props as { id?: string }).id || id,
      "aria-describedby": mergedDescribedBy,
      "aria-invalid": error ? true : (children.props as { "aria-invalid"?: boolean })["aria-invalid"],
    });
  }

  return (
    <div className={cx("block", className)}>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-slate-800">
        {label}
      </label>
      {inputContent}
      {hint && <span id={hintId} className="mt-1 block text-xs text-slate-600">{hint}</span>}
      {error && <span id={errorId} role="alert" className="mt-1 block text-xs font-medium text-red-700">{error}</span>}
    </div>
  );
}

export const inputCls = "w-full min-h-[44px] rounded-md border border-slate-300 bg-white px-3 py-2 text-[15px] text-slate-900 focus:border-teal-700 focus:outline-none focus:ring-2 focus:ring-teal-700/40";

// ---------------------------------------------------------------- toasts (aria-live)
type Toast = { id: number; kind: "success" | "error" | "info"; text: string };
const ToastCtx = createContext<(kind: Toast["kind"], text: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed bottom-20 right-4 z-[60] flex w-[min(24rem,calc(100%-2rem))] flex-col gap-2 md:bottom-14">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            aria-live={t.kind === "error" ? "assertive" : "polite"}
            className={cx(
              "pointer-events-auto rounded-md border px-4 py-3 text-sm shadow-md",
              t.kind === "error"
                ? "border-red-200 bg-red-50 text-red-900"
                : t.kind === "success"
                ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                : "border-slate-200 bg-white text-slate-800"
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
