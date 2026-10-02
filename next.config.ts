import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Brand assets use next/image; the standalone container has a read-only root.
  images: { maximumDiskCacheSize: 0 },
  outputFileTracingRoot: path.resolve(process.cwd()),
  experimental: { cpus: 2 },
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**/*"],
  },
};

export default nextConfig;
