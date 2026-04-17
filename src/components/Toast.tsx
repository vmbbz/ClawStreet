/**
 * Toast.tsx — Global notification system
 * Usage: import { toast } from '../components/Toast'
 *        toast.success('Transaction confirmed!')
 *        toast.error('Rejected by user')
 *        toast.tx('Loan funded', txHash)       ← shows Basescan link
 */
import React, { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, XCircle, AlertCircle, Info, X, ExternalLink } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

type ToastType = 'success' | 'error' | 'warning' | 'info' | 'tx';

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  txHash?: string;
  duration?: number;
}

// ─── Global event bus ─────────────────────────────────────────────────────────

const TOAST_EVENT = 'cs-toast';

function emit(item: Omit<ToastItem, 'id'>) {
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, {
    detail: { ...item, id: Math.random().toString(36).slice(2) },
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

export const toast = {
  success: (message: string, duration = 4000) => emit({ type: 'success', message, duration }),
  error:   (message: string, duration = 6000) => emit({ type: 'error',   message, duration }),
  warning: (message: string, duration = 5000) => emit({ type: 'warning', message, duration }),
  info:    (message: string, duration = 4000) => emit({ type: 'info',    message, duration }),
  tx:      (message: string, txHash: string)  => emit({ type: 'tx', message, txHash, duration: 8000 }),
};

// ─── Icons ────────────────────────────────────────────────────────────────────

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0" />,
  error:   <XCircle      size={16} className="text-red-400    flex-shrink-0" />,
  warning: <AlertCircle  size={16} className="text-yellow-400 flex-shrink-0" />,
  info:    <Info         size={16} className="text-base-blue  flex-shrink-0" />,
  tx:      <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0" />,
};

const BORDER: Record<ToastType, string> = {
  success: 'border-emerald-500/30',
  error:   'border-red-500/30',
  warning: 'border-yellow-500/30',
  info:    'border-base-blue/30',
  tx:      'border-emerald-500/30',
};

// ─── Single Toast item ────────────────────────────────────────────────────────

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (id: string) => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Animate in
    const showTimer = setTimeout(() => setVisible(true), 10);
    // Auto-dismiss
    const hideTimer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => onDismiss(item.id), 300);
    }, item.duration ?? 4000);

    return () => { clearTimeout(showTimer); clearTimeout(hideTimer); };
  }, [item.id, item.duration, onDismiss]);

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 bg-cyber-surface border ${BORDER[item.type]} rounded-xl shadow-2xl shadow-black/40 max-w-sm w-full transition-all duration-300 ${visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'}`}
    >
      {ICONS[item.type]}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-white leading-snug">{item.message}</p>
        {item.txHash && (
          <a
            href={`https://sepolia.basescan.org/tx/${item.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-emerald-400/80 hover:text-emerald-400 mt-1 transition-colors"
          >
            View on Basescan <ExternalLink size={10} />
          </a>
        )}
      </div>
      <button
        onClick={() => { setVisible(false); setTimeout(() => onDismiss(item.id), 300); }}
        className="text-gray-600 hover:text-gray-300 transition-colors flex-shrink-0 -mt-0.5"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ─── Toast container (rendered once in App.tsx) ───────────────────────────────

export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const item = (e as CustomEvent<ToastItem>).detail;
      setToasts(prev => [...prev.slice(-4), item]); // cap at 5
    };
    window.addEventListener(TOAST_EVENT, handler);
    return () => window.removeEventListener(TOAST_EVENT, handler);
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map(t => (
        <div key={t.id} className="pointer-events-auto">
          <ToastCard item={t} onDismiss={dismiss} />
        </div>
      ))}
    </div>
  );
}
