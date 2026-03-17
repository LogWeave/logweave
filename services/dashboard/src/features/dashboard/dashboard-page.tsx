import { KpiStrip } from './kpi-strip'
import { ServiceHealthCards } from './service-health-cards'
import { TemplateTable } from './template-table'
import { VolumeChart } from './volume-chart'

export function DashboardPage() {
  return (
    <div className="space-y-6">
      {/* Row 1: KPI strip */}
      <KpiStrip />

      {/* Row 2: Volume chart */}
      <VolumeChart />

      {/* Row 3: Template table (2/3) + Service cards (1/3) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <TemplateTable className="lg:col-span-2" />
        <ServiceHealthCards />
      </div>
    </div>
  )
}
