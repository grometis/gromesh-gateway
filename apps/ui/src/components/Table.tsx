import type { ReactNode } from "react";

/** A table that scrolls on its own when wider than the screen; `cards` turns rows into separate surfaces. */
export function Table({ label, cards, focusable=false, children }: { label?: string; cards?: boolean; focusable?:boolean; children: ReactNode }) {
  return (
    <div className="table-scroll" tabIndex={focusable?0:undefined} role={focusable?"region":undefined} aria-label={focusable?label:undefined}>
      <table aria-label={label} className={cards ? "cards" : undefined}>
        {children}
      </table>
    </div>
  );
}
