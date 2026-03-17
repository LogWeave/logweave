import { KpiStrip } from '../dashboard/kpi-strip'
import { ServiceHealthCards } from '../dashboard/service-health-cards'
import { TemplateTable } from '../dashboard/template-table'
import { VolumeChart } from '../dashboard/volume-chart'

export function DashboardV2Page() {
  return (
    <div className="space-y-6">
      {/* V2: Charts-first layout — volume chart is the hero */}
      <VolumeChart />

      {/* KPI strip below chart */}
      <KpiStrip />

      {/* Service cards and template table side by side, swapped */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <ServiceHealthCards />
        <TemplateTable className="lg:col-span-3" />
      </div>
    </div>
  )
}
