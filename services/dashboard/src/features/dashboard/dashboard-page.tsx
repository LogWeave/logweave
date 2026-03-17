import { ErrorBoundary } from '../../components/error-boundary'
import { KpiStrip } from './kpi-strip'
import { ServiceHealthCards } from './service-health-cards'
import { TemplateTable } from './template-table'
import { VolumeChart } from './volume-chart'

export function DashboardPage() {
  return (
    <div className="space-y-6">
      <ErrorBoundary name="KPI Strip">
        <KpiStrip />
      </ErrorBoundary>

      <ErrorBoundary name="Volume Chart">
        <VolumeChart />
      </ErrorBoundary>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <ErrorBoundary name="Template Table">
          <TemplateTable className="lg:col-span-2" />
        </ErrorBoundary>
        <ErrorBoundary name="Service Health">
          <ServiceHealthCards />
        </ErrorBoundary>
      </div>
    </div>
  )
}
