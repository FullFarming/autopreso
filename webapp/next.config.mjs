import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The webapp lives inside the autopreso repo, which has its own lockfile;
  // pin tracing to this directory so Next does not walk up to the parent.
  outputFileTracingRoot: projectRoot,
};

export default nextConfig;
