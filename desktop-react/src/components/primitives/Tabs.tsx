import type { ReactNode } from "react";

export type TabItem<T extends string> = {
  id: T;
  label: string;
  badge?: number;
};

type Props<T extends string> = {
  active: T;
  tabs: TabItem<T>[];
  onChange: (id: T) => void;
};

export function Tabs<T extends string>({ active, tabs, onChange }: Props<T>) {
  return (
    <div className="hstack" role="tablist" aria-label="tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`list-row ${tab.id === active ? "active" : ""}`}
          onClick={() => onChange(tab.id)}
          role="tab"
          aria-selected={tab.id === active}
        >
          <span>{tab.label}</span>
          {typeof tab.badge === "number" ? <span className="badge">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ children }: { children: ReactNode }) {
  return <section>{children}</section>;
}

