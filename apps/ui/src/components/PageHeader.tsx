import type { ReactNode } from "react";

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  const heading = <h1>{title}</h1>;
  return (
    <div className="page-head">
      {description ? <div>{heading}<p className="lede">{description}</p></div> : heading}
      {actions}
    </div>
  );
}
