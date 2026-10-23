import type { ReactNode } from "react";

export function EmptyState({ title, text, action }: { title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state muted">
      <h2>{title}</h2>
      {text && <> <p>{text}</p></>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
