import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Schoolium — School Management Made Simple',
  description: 'Manage students, fees, attendance and more. Built for private schools in India.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-slate-50 antialiased">
        {children}
      </body>
    </html>
  )
}
