import { AlertTriangle } from 'lucide-react'

interface QueryErrorProps {
  message?: string
  onRetry?: () => void
}

export function QueryError({ message = 'Failed to load data', onRetry }: QueryErrorProps) {
  return (
    <div className="flex flex-col items-center justify-center py-6 text-center">
      <AlertTriangle size={20} className="text-danger mb-2" />
      <p className="text-sm text-danger font-medium">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 text-xs text-brand-400 hover:text-brand-300 transition-colors"
        >
          Click to retry
        </button>
      )}
    </div>
  )
}
