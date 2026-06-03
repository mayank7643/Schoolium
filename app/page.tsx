import Link from 'next/link'

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white">
      {/* Navbar */}
      <nav className="border-b border-slate-100 px-6 py-4 flex items-center justify-between max-w-6xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 bg-brand-600 rounded-lg flex items-center justify-center">
            <span className="text-white font-bold text-sm">S</span>
          </div>
          <span className="font-semibold text-slate-900 text-lg">Schoolium</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-slate-600 hover:text-slate-900 transition-colors">
            Sign in
          </Link>
          <Link href="/signup" className="btn-primary text-sm">
            Get started
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-20 pb-16 text-center">
        <div className="inline-flex items-center gap-2 bg-brand-50 text-brand-700 text-xs font-medium px-3 py-1.5 rounded-full mb-6">
          <span className="w-1.5 h-1.5 bg-brand-500 rounded-full"></span>
          Built for private schools in India
        </div>

        <h1 className="text-4xl sm:text-5xl font-bold text-slate-900 leading-tight mb-6">
          School management,{' '}
          <span className="text-brand-600">finally simple</span>
        </h1>

        <p className="text-lg text-slate-500 max-w-2xl mx-auto mb-10">
          Students, fees, attendance, receipts — all in one place.
          No spreadsheets. No paperwork. Just results.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link href="/signup" className="btn-primary px-8 py-3 text-base w-full sm:w-auto">
            Start free — ₹299/month
          </Link>
          <Link href="/login" className="btn-secondary px-8 py-3 text-base w-full sm:w-auto">
            Sign in to dashboard
          </Link>
        </div>

        <p className="text-xs text-slate-400 mt-4">No credit card required. Cancel anytime.</p>
      </section>

      {/* Features */}
      <section className="max-w-5xl mx-auto px-6 pb-20">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
          {[
            {
              icon: '👨‍🎓',
              title: 'Student records',
              desc: 'Admissions, profiles, class assignments — all searchable in seconds.',
            },
            {
              icon: '💰',
              title: 'Fee management',
              desc: 'Track payments, send receipts, see who is pending — automatically.',
            },
            {
              icon: '📄',
              title: 'PDF receipts',
              desc: 'Professional receipts generated instantly. Share via WhatsApp or print.',
            },
          ].map((f) => (
            <div key={f.title} className="card text-center">
              <div className="text-3xl mb-3">{f.icon}</div>
              <h3 className="font-semibold text-slate-900 mb-2">{f.title}</h3>
              <p className="text-sm text-slate-500">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 py-6 text-center text-xs text-slate-400">
        © {new Date().getFullYear()} Schoolium. All rights reserved.
      </footer>
    </main>
  )
}
