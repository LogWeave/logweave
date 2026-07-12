import { useLocation } from 'react-router-dom'
import { AnomalyWarmupBanner } from '../../components/anomaly-warmup-banner'
import { ErrorBoundary } from '../../components/error-boundary'
import { useUrlSync } from '../../hooks/use-url-sync'
import { OnboardingCard } from '../onboarding/onboarding-card'
import { ChangesPanel } from './changes-panel'
import { CostWidget } from './cost-widget'
import { KpiStrip } from './kpi-strip'
import { ServiceHealthCards } from './service-health-cards'
import { TemplateTable } from './template-table'
import { VolumeChart } from './volume-chart'

export function DashboardPage() {
  const location = useLocation()
  useUrlSync()

  return (
    <div className="space-y-6">
      {/* Onboarding — shown until all steps complete or dismissed */}
      <ErrorBoundary name="Onboarding">
        <OnboardingCard />
      </ErrorBoundary>

      {/* Anomaly warmup — hidden once scoring reaches steady state */}
      <ErrorBoundary name="Anomaly Warmup">
        <AnomalyWarmupBanner />
      </ErrorBoundary>

      {/* Row 1: KPI strip — priority tier layout */}
      <ErrorBoundary name="KPI Strip" key={`kpi-${location.key}`}>
        <KpiStrip />
      </ErrorBoundary>

      {/* Row 2: What Changed — most actionable, above the fold */}
      <ErrorBoundary name="What Changed" key={`changes-${location.key}`}>
        <ChangesPanel />
      </ErrorBoundary>

      {/* Row 3: Volume chart */}
      <ErrorBoundary name="Volume Chart" key={`vol-${location.key}`}>
        <VolumeChart />
      </ErrorBoundary>

      {/* Row 4: Cost optimizer */}
      <ErrorBoundary name="Cost Optimizer" key={`cost-${location.key}`}>
        <CostWidget />
      </ErrorBoundary>

      {/* Row 5: Template table + Service cards */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        <ErrorBoundary name="Template Table" key={`tpl-${location.key}`}>
          <TemplateTable className="xl:col-span-3" />
        </ErrorBoundary>
        <ErrorBoundary name="Service Health" key={`svc-${location.key}`}>
          <ServiceHealthCards className="xl:col-span-2" />
        </ErrorBoundary>
      </div>
    </div>
  )
}
