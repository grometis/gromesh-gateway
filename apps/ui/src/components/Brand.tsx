import type { Ref } from "react";
import { Link } from "react-router";

/** Original Malha outlines; the theme selects the approved monochrome asset. */
export function Brand({ inverse = false, linkRef }: { inverse?: boolean; linkRef?: Ref<HTMLAnchorElement> }) {
  return (
    <Link ref={linkRef} to="/" className="brand" aria-label="gromesh, início">
      <img src={`/brand/gromesh-logo-${inverse ? "escuro" : "claro"}.svg`} alt="Gromesh" height={inverse ? 20 : 34} />
    </Link>
  );
}
