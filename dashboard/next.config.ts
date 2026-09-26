import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Stagehand ships extension assets resolved via `import.meta.url` relative
  // paths, which Turbopack can't statically bundle for a server route.
  // Externalizing it makes Next require() it at runtime instead of bundling.
  serverExternalPackages: ["@browserbasehq/stagehand"],
};

export default nextConfig;
