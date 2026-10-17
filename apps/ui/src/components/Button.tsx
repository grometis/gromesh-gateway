import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger";

/** 44px tall, radius 10: primary (accent), secondary (outlined) or danger (destructive, outlined). */
export function Button({ variant = "secondary", className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const variantClass = variant === "secondary" ? "" : variant;
  return <button type={type} className={[variantClass, className].filter(Boolean).join(" ") || undefined} {...rest} />;
}
