import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Card } from './ui/card'

interface Props {
  children: ReactNode
  name?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name ?? 'Widget'}] crashed:`, error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <Card className="border-danger/30 bg-danger/5">
          <div className="text-center py-6">
            <p className="text-sm font-medium text-danger mb-1">
              {this.props.name ?? 'Widget'} crashed
            </p>
            <p className="text-xs text-text-muted">{this.state.error.message}</p>
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="mt-3 text-xs text-brand-400 hover:text-brand-300"
            >
              Try again
            </button>
          </div>
        </Card>
      )
    }
    return this.props.children
  }
}
