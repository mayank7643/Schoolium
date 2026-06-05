export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto">
      {/* Header skeleton */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="h-8 w-40 bg-slate-200 rounded-lg animate-pulse mb-2" />
          <div className="h-4 w-24 bg-slate-100 rounded animate-pulse" />
        </div>
        <div className="h-9 w-32 bg-slate-200 rounded-lg animate-pulse" />
      </div>

      {/* Stat cards skeleton */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="stat-card">
            <div className="w-9 h-9 bg-slate-200 rounded-lg animate-pulse mb-3" />
            <div className="h-7 w-20 bg-slate-200 rounded animate-pulse mb-1" />
            <div className="h-3 w-16 bg-slate-100 rounded animate-pulse" />
          </div>
        ))}
      </div>

      {/* Table skeleton */}
      <div className="card p-0 overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-3 flex gap-8">
          {['Name', 'Class', 'Amount', 'Status', 'Date'].map(h => (
            <div key={h} className="h-3 w-16 bg-slate-200 rounded animate-pulse" />
          ))}
        </div>
        {[...Array(6)].map((_, i) => (
          <div key={i} className="border-b border-slate-50 px-4 py-4 flex gap-8 items-center">
            <div className="h-4 w-28 bg-slate-100 rounded animate-pulse" />
            <div className="h-4 w-16 bg-slate-100 rounded animate-pulse" />
            <div className="h-4 w-20 bg-slate-100 rounded animate-pulse" />
            <div className="h-5 w-14 bg-slate-100 rounded-full animate-pulse" />
            <div className="h-4 w-20 bg-slate-100 rounded animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
