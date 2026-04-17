/**
 * SkeletonCard.tsx — Animated placeholder cards while Market data loads
 */
export function SkeletonCard() {
  return (
    <div className="bg-cyber-surface rounded-xl border border-cyber-border overflow-hidden flex flex-col animate-pulse">
      {/* Card header shimmer */}
      <div className="h-20 bg-cyber-bg relative flex items-center justify-center border-b border-cyber-border">
        <div className="absolute top-2 left-3 w-12 h-4 bg-white/5 rounded" />
        <div className="absolute top-2 right-3 w-20 h-4 bg-white/5 rounded" />
        <div className="w-7 h-7 bg-white/5 rounded-lg" />
      </div>

      <div className="p-4 flex-grow flex flex-col gap-3">
        {/* Title row */}
        <div className="flex justify-between items-start">
          <div className="space-y-1.5">
            <div className="w-32 h-4 bg-white/5 rounded" />
            <div className="w-24 h-3 bg-white/5 rounded" />
          </div>
          <div className="w-12 h-5 bg-white/5 rounded-full" />
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 gap-2 flex-grow">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-cyber-bg p-2 rounded-lg border border-cyber-border space-y-1.5">
              <div className="w-12 h-2.5 bg-white/5 rounded" />
              <div className="w-16 h-4 bg-white/5 rounded" />
            </div>
          ))}
        </div>

        {/* Buttons */}
        <div className="flex gap-2 mt-1">
          <div className="flex-1 h-8 bg-white/5 rounded-lg" />
          <div className="flex-1 h-8 bg-white/5 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

export function SkeletonGrid({ count = 6 }: { count?: number }) {
  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
      {[...Array(count)].map((_, i) => <SkeletonCard key={i} />)}
    </div>
  );
}
