import { Link } from "react-router";

/** The product's name as a wordmark: the one place a future logo goes. */
export function Brand() {
  return (
    <Link to="/" className="brand" aria-label="gromesh, início">
      gromesh
    </Link>
  );
}
