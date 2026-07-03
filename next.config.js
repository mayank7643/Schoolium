/** @type {import('next').NextConfig} */
const nextConfig = {
  // @react-pdf/renderer must be treated as an external package on the server so
  // Next does not try to bundle its native-ish deps (fontkit/yoga) - required
  // for the /api/wa/worker route to render PDFs on Vercel.
  experimental: {
    serverComponentsExternalPackages: ['@react-pdf/renderer'],
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        port: '',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },
}

module.exports = nextConfig
