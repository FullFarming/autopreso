export function isHostSessionPage(pathname: string | null): boolean {
  return pathname === "/admin" || pathname === "/records" || pathname === "/m/records";
}
