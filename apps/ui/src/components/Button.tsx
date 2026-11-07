import type { ButtonHTMLAttributes } from "react";

type Variant = "publish" | "primary" | "secondary" | "quiet" | "danger";

/** Shared actions inherit responsive targets and semantic colours from the product tokens. */
export function Button({ variant = "secondary", className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const variantClass = variant === "secondary" ? "" : variant;
  return <button type={type} className={[variantClass, className].filter(Boolean).join(" ") || undefined} {...rest} />;
}
