import { useLocation } from 'react-router-dom'
import { ErrorBoundary } from '../../components/error-boundary'
import { KpiStrip } from './kpi-strip'
import { ServiceHealthCards } from './service-health-cards'
import { TemplateTable } from './template-table'
import { VolumeChart } from './volume-chart'

export function DashboardPage() {
  const location = useLocation()

  return (
    <div className="space-y-6">
      <ErrorBoundary name="KPI Strip" key={`kpi-${location.key}`}>
        <KpiStrip />
      </ErrorBoundary>

      <ErrorBoundary name="Volume Chart" key={`vol-${location.key}`}>
        <VolumeChart />
      </ErrorBoundary>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <ErrorBoundary name="Template Table" key={`tpl-${location.key}`}>
          <TemplateTable className="lg:col-span-2" />
        </ErrorBoundary>
        <ErrorBoundary name="Service Health" key={`svc-${location.key}`}>
          <ServiceHealthCards />
        </ErrorBoundary>
      </div>
    </div>
  )
}
