import type { ReactNode } from "react";

/** A table that scrolls on its own when wider than the screen; `cards` turns rows into separate surfaces. */
export function Table({ label, cards, children }: { label?: string; cards?: boolean; children: ReactNode }) {
  return (
    <div className="table-scroll">
      <table aria-label={label} className={cards ? "cards" : undefined}>
        {children}
      </table>
    </div>
  );
}
