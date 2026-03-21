import { useCallback, useEffect, useRef, useState } from 'react'
import { config } from '../../config'

export interface TailEvent {
  seq: number
  timestamp: string
  service: string
  level: string
  templateId: string
  templateText: string
  preProcessedMessage?: string
  anomalyScore: number
  statusCode: number
  durationMs: number
  traceId: string
  route: string
}

export type TailStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface TailFilters {
  service?: string
  level?: string
  templateId?: string
  minAnomaly?: number
}

interface UseTailOptions {
  maxEvents?: number
  autoDisconnectMs?: number
}

export function useTail(filters: TailFilters, options?: UseTailOptions) {
  const [events, setEvents] = useState<TailEvent[]>([])
  const [status, setStatus] = useState<TailStatus>('disconnected')
  const [error, setError] = useState<string | undefined>()
  const [eventRate, setEventRate] = useState(0)
  const eventSourceRef = useRef<EventSource | null>(null)
  const rateCountRef = useRef(0)
  const rateTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const maxEvents = options?.maxEvents ?? 500
  const autoDisconnectMs = options?.autoDisconnectMs ?? 10 * 60 * 1000

  const resetActivityTimer = useCallback(() => {
    if (activityTimerRef.current) clearTimeout(activityTimerRef.current)
    activityTimerRef.current = setTimeout(() => {
      disconnect()
    }, autoDisconnectMs)
  }, [autoDisconnectMs])

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
    if (rateTimerRef.current) {
      clearInterval(rateTimerRef.current)
      rateTimerRef.current = null
    }
    if (activityTimerRef.current) {
      clearTimeout(activityTimerRef.current)
      activityTimerRef.current = null
    }
    setStatus('disconnected')
    setEventRate(0)
  }, [])

  const connect = useCallback(() => {
    disconnect()
    setStatus('connecting')
    setError(undefined)
    setEvents([])

    const params = new URLSearchParams()
    if (filters.service) params.set('service', filters.service)
    if (filters.level) params.set('level', filters.level)
    if (filters.templateId) params.set('template_id', filters.templateId)
    if (filters.minAnomaly !== undefined) params.set('min_anomaly', String(filters.minAnomaly))
    // EventSource can't send Authorization headers — pass API key as query param
    if (config.apiKey) params.set('api_key', config.apiKey)

    const url = `${config.apiUrl}/v1/tail?${params.toString()}`
    const es = new EventSource(url)

    eventSourceRef.current = es

    es.onopen = () => {
      setStatus('connected')
      resetActivityTimer()
    }

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as TailEvent
        setEvents((prev) => {
          const next = [...prev, event]
          return next.length > maxEvents ? next.slice(-maxEvents) : next
        })
        rateCountRef.current++
        resetActivityTimer()
      } catch {
        // Ignore malformed events
      }
    }

    es.addEventListener('gap', (e) => {
      const data = JSON.parse((e as MessageEvent).data)
      setError(`Missed ~${data.missedEstimate} events (buffer wrapped)`)
    })

    es.addEventListener('error', (e) => {
      const data = (e as MessageEvent).data
      if (data) {
        try {
          const parsed = JSON.parse(data)
          if (parsed.reason === 'backpressure') {
            setError('Disconnected: could not keep up with event rate')
          }
        } catch { /* not JSON */ }
      }
    })

    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        setStatus('disconnected')
      } else {
        setStatus('connecting') // auto-reconnecting
      }
    }

    // Rate calculation every second
    rateCountRef.current = 0
    rateTimerRef.current = setInterval(() => {
      setEventRate(rateCountRef.current)
      rateCountRef.current = 0
    }, 1000)
  }, [filters, maxEvents, disconnect, resetActivityTimer])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect()
    }
  }, [disconnect])

  return {
    events,
    status,
    error,
    eventRate,
    connect,
    disconnect,
    isConnected: status === 'connected',
    clear: () => setEvents([]),
  }
}
