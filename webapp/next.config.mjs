import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  // lib/ imports ../../packages/{caption-core,gemini-server} from the repo
  // root, so serverless function traces must include files above webapp/.
  // Keep this the repo root (not webapp/) or those modules are dropped from
  // the deployed functions and API routes crash at runtime.
  outputFileTracingRoot: path.join(projectRoot, ".."),
  // sharp's linux-x64 binary dlopens libvips from the sibling @img/sharp-libvips-* package, which
  // the file tracer cannot see (no JS require edge). Without this the speaker photo route fails
  // with ERR_DLOPEN_FAILED on Vercel. Paths are relative to outputFileTracingRoot (the repo root).
  outputFileTracingIncludes: {
    "/api/live-sessions/[id]/speakers/photos": ["./webapp/node_modules/@img/**/*"],
  },
};

export default nextConfig;
