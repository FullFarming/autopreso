export function isDevelopmentRecordDemoRequest(pathname: string, method: string, environment: string | undefined): boolean {
  return environment === "development" && method === "GET"
    && (pathname === "/records/demo" || pathname === "/m/records/demo");
}
