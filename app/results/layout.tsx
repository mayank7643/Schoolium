import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Check Result',
  robots: { index: false, follow: false },
}

export default function ResultsLayout({ children }: { children: React.ReactNode }) {
  return children
}
