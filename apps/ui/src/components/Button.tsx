import type { ButtonHTMLAttributes } from "react";

type Variant = "publish" | "primary" | "secondary" | "quiet" | "danger";

/**
 * 44px tall, radius 10. publish: the accent, only for publishing; primary: the ink outline (main action of a screen);
 * secondary: outlined; quiet: no border, for row actions; danger: destructive, outlined.
 */
export function Button({ variant = "secondary", className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const variantClass = variant === "secondary" ? "" : variant;
  return <button type={type} className={[variantClass, className].filter(Boolean).join(" ") || undefined} {...rest} />;
}
