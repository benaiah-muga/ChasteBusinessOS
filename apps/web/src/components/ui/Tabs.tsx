"use client";

import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type TabsCtx = {
  value: string;
  setValue: (v: string) => void;
};

const TabsContext = createContext<TabsCtx | null>(null);

function useTabsCtx(): TabsCtx {
  const v = useContext(TabsContext);
  if (!v) throw new Error("Tabs must be used inside <Tabs>");
  return v;
}

export function Tabs({
  defaultValue,
  value: controlledValue,
  onValueChange,
  children,
}: {
  defaultValue: string;
  value?: string;
  onValueChange?: (v: string) => void;
  children: ReactNode;
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const value = controlledValue ?? uncontrolled;
  const setValue = (next: string) => {
    if (controlledValue === undefined) setUncontrolled(next);
    onValueChange?.(next);
  };

  const { tabs, panels } = useMemo(() => {
    const tabNodes: ReactNode[] = [];
    const panelNodes: ReactNode[] = [];
    Children.forEach(children, (child) => {
      if (!isValidElement(child)) return;
      if (child.type === Tab) tabNodes.push(child);
      else if (child.type === TabPanel) panelNodes.push(child);
      else panelNodes.push(child);
    });
    return { tabs: tabNodes, panels: panelNodes };
  }, [children]);

  return (
    <TabsContext.Provider value={{ value, setValue }}>
      <div className="tabs-root">
        <div className="tabs" role="tablist">
          {tabs}
        </div>
        <div className="tabs-panels">{panels}</div>
      </div>
    </TabsContext.Provider>
  );
}

export function Tab({
  value,
  label,
  icon,
  count,
}: {
  value: string;
  label: string;
  icon?: React.ComponentType<{ size?: number }>;
  count?: number;
}) {
  const ctx = useTabsCtx();
  const Icon = icon;
  const active = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`tab${active ? " active" : ""}`}
      onClick={() => ctx.setValue(value)}
    >
      {Icon ? <Icon size={15} /> : null}
      <span>{label}</span>
      {typeof count === "number" ? <span className="count">{count}</span> : null}
    </button>
  );
}

export function TabPanel({
  value,
  children,
}: {
  value: string;
  children: ReactNode;
}) {
  const ctx = useTabsCtx();
  if (ctx.value !== value) return null;
  return (
    <div className="tab-panel active" role="tabpanel">
      {children}
    </div>
  );
}

export function useTabsState(initial: string): [string, (v: string) => void] {
  const [value, setValue] = useState(initial);
  return [value, setValue];
}
