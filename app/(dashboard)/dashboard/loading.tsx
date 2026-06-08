export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto">
      {/* Header skeleton */}
      <div className="mb-6">
        <div className="h-7 w-36 bg-slate-200 rounded-lg animate-pulse mb-2" />
        <div className="h-3.5 w-40 bg-slate-100 rounded animate-pulse" />
      </div>

      {/* Stat cards skeleton */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4 mb-6">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="stat-card">
            <div className="w-8 h-8 bg-slate-200 rounded-lg animate-pulse mb-2" />
            <div className="h-6 w-16 bg-slate-200 rounded animate-pulse mb-1" />
            <div className="h-3 w-20 bg-slate-100 rounded animate-pulse" />
          </div>
        ))}
      </div>

      {/* Quick actions skeleton */}
      <div className="card">
        <div className="h-4 w-24 bg-slate-200 rounded animate-pulse mb-3" />
        <div className="flex gap-2">
          <div className="h-9 w-28 bg-slate-200 rounded-lg animate-pulse" />
          <div className="h-9 w-32 bg-slate-100 rounded-lg animate-pulse" />
          <div className="h-9 w-32 bg-slate-100 rounded-lg animate-pulse" />
        </div>
      </div>
    </div>
  )
}
