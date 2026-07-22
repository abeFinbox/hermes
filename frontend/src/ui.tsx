import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** Tiny toast system. */
interface ToastCtx {
  toast: (message: string, kind?: 'ok' | 'error') => void;
}
const TCtx = createContext<ToastCtx>({ toast: () => {} });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null);
  const toast = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    setMsg({ text, kind });
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), msg.kind === 'error' ? 5000 : 2500);
    return () => clearTimeout(t);
  }, [msg]);
  return (
    <TCtx.Provider value={{ toast }}>
      {children}
      {msg && <div className={`toast ${msg.kind === 'error' ? 'error' : ''}`}>{msg.text}</div>}
    </TCtx.Provider>
  );
}

export function useToast() {
  return useContext(TCtx).toast;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row mb">
          <h2 className="grow" style={{ margin: 0 }}>{title}</h2>
          <button className="btn small" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Confirm({ message, onYes, onNo }: { message: string; onYes: () => void; onNo: () => void }) {
  return (
    <Modal title="Are you sure?" onClose={onNo}>
      <p>{message}</p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onNo}>Cancel</button>
        <button className="btn danger" onClick={onYes}>Yes, do it</button>
      </div>
    </Modal>
  );
}
