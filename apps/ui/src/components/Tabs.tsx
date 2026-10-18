import { useId, type ReactNode } from "react";

export interface Tab<Id extends string> {
  id: Id;
  label: string;
}

/** WAI-ARIA tabs: one panel at a time, arrow keys move between tabs from the focused one. */
export function Tabs<Id extends string>(props: { label: string; tabs: readonly Tab<Id>[]; active: Id; onChange: (id: Id) => void; children: ReactNode }) {
  const { label, tabs, active, onChange } = props;
  const base = useId();
  const tabId = (id: Id) => `${base}-tab-${id}`;
  const move = (from: number, delta: number) => {
    const next = tabs[(from + delta + tabs.length) % tabs.length]!;
    onChange(next.id);
    document.getElementById(tabId(next.id))?.focus();
  };
  return (
    <div>
      <div role="tablist" aria-label={label} className="tabs">
        {tabs.map((t, i) => (
          <button
            key={t.id}
            id={tabId(t.id)}
            type="button"
            role="tab"
            aria-selected={t.id === active}
            aria-controls={`${base}-panel`}
            tabIndex={t.id === active ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") move(i, 1);
              if (e.key === "ArrowLeft") move(i, -1);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={tabId(active)}>
        {props.children}
      </div>
    </div>
  );
}
