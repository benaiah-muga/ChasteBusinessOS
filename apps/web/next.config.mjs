/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@chaste/kernel", "@chaste/db", "@chaste/ai"],
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
