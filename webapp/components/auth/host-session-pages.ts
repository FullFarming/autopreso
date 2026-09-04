export function isHostSessionPage(pathname: string | null): boolean {
  if (pathname === null) return false;
  // The admin console (/console, /console/users, ...) is a host surface too: it needs the same
  // session maintenance as the dashboard, and only exact "/console" or a "/console/" child counts.
  if (pathname === "/console" || pathname.startsWith("/console/")) return true;
  return pathname === "/admin" || pathname === "/records" || pathname === "/m/records";
}
