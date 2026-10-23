import * as ToastPrimitive from "@radix-ui/react-toast";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Check, Info, TriangleAlert, X } from "lucide-react";
import { cn } from "./cn";

type ToastTone = "default" | "success" | "danger";

type ToastInput = {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
  action?: { label: string; onClick: () => void };
};

type ToastRecord = ToastInput & { id: number; open: boolean };

type ToastContextValue = { toast: (input: ToastInput) => void };

const ToastContext = createContext<ToastContextValue>({ toast: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<ToastRecord[]>([]);

  const toast = useCallback((input: ToastInput) => {
    const id = Date.now() + Math.random();
    setRecords((current) => [...current.slice(-3), { ...input, id, open: true }]);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      <ToastPrimitive.Provider swipeDirection="right" duration={4800}>
        {children}
        {records.map((record) => (
          <ToastPrimitive.Root
            key={record.id}
            open={record.open}
            onOpenChange={(open) => {
              if (!open) setRecords((current) => current.filter((item) => item.id !== record.id));
            }}
            className={cn("ui-toast", record.tone === "success" && "ui-toast-success", record.tone === "danger" && "ui-toast-danger")}
          >
            <span className="ui-toast-icon" aria-hidden="true">
              {record.tone === "success" ? <Check size={15} /> : record.tone === "danger" ? <TriangleAlert size={15} /> : <Info size={15} />}
            </span>
            <div className="ui-toast-copy">
              <ToastPrimitive.Title className="ui-toast-title">{record.title}</ToastPrimitive.Title>
              {record.description && <ToastPrimitive.Description className="ui-toast-description">{record.description}</ToastPrimitive.Description>}
              {record.action && (
                <ToastPrimitive.Action altText={record.action.label} className="ui-toast-action" onClick={record.action.onClick}>
                  {record.action.label}
                </ToastPrimitive.Action>
              )}
            </div>
            <ToastPrimitive.Close className="ui-toast-close" aria-label="Dismiss notification">
              <X size={14} />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="ui-toast-viewport" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
