import { Router } from 'express'
import type pino from 'pino'
import type { DbClient } from '../db/client.js'
import type { CostAnalysisRow } from '../db/cost-queries.js'
import { queryCostAnalysis } from '../db/cost-queries.js'
import { getTenantId } from '../middleware/auth.js'
import { getQuery, validateQuery } from '../middleware/validate-query.js'
import { respond } from '../lib/respond.js'
import type { TenantSettingsStore } from '../watches/tenant-settings.js'
import type {
  Classification,
  CostAnalysisData,
  CostAnalysisQuery,
  CostPattern,
  CostThresholds,
} from './cost-types.js'
import { costAnalysisSchema } from './cost-types.js'

export interface CostDeps {
  db: DbClient
  logger: pino.Logger
  settingsStore: TenantSettingsStore
}

const DEFAULT_NOISE_DEBUG_PCT = 5
const DEFAULT_REVIEW_INFO_PCT = 10
const DEFAULT_REVIEW_WARN_PCT = 20

const NOISE_LEVELS = new Set(['DEBUG', 'TRACE'])

function classify(
  level: string,
  volumePct: number,
  thresholds: CostThresholds,
): { classification: Classification; suggestion: string } | null {
  const upperLevel = level.toUpperCase()

  if (NOISE_LEVELS.has(upperLevel) && volumePct > thresholds.noiseDebugPct) {
    return {
      classification: 'noise',
      suggestion: `Consider removing — ${upperLevel} logging in production, ${volumePct.toFixed(1)}% of service volume`,
    }
  }

  if (upperLevel === 'INFO' && volumePct > thresholds.reviewInfoPct) {
    return {
      classification: 'review',
      suggestion: `Consider sampling — high volume INFO pattern, ${volumePct.toFixed(1)}% of service volume`,
    }
  }

  if (upperLevel === 'WARN' && volumePct > thresholds.reviewWarnPct) {
    return {
      classification: 'review',
      suggestion: `Consider sampling — high volume warnings, ${volumePct.toFixed(1)}% of service volume`,
    }
  }

  return null
}

function buildPatterns(
  rows: CostAnalysisRow[],
  thresholds: CostThresholds,
): {
  patterns: CostPattern[]
  totalPatternsAnalyzed: number
  noiseCount: number
  reviewCount: number
  keepCount: number
  potentialReductionPct: number
} {
  const patterns: CostPattern[] = []
  let noiseCount = 0
  let reviewCount = 0
  let keepCount = 0
  let reducibleCount = 0

  // Deduplicate service totals — each service appears once in the window function result
  const serviceTotals = new Map<string, number>()
  for (const row of rows) {
    if (!serviceTotals.has(row.service)) {
      serviceTotals.set(row.service, Number(row.service_total))
    }
  }
  const totalEvents = [...serviceTotals.values()].reduce((sum, v) => sum + v, 0)

  for (const row of rows) {
    const count = Number(row.count)
    const serviceTotal = Number(row.service_total)
    const volumePct = serviceTotal > 0 ? (count / serviceTotal) * 100 : 0

    const result = classify(row.level, volumePct, thresholds)
    if (result) {
      if (result.classification === 'noise') noiseCount++
      else reviewCount++
      reducibleCount += count

      patterns.push({
        templateId: row.template_id,
        template: row.template_text,
        service: row.service,
        level: row.level,
        count,
        volumePct: Math.round(volumePct * 10) / 10,
        classification: result.classification,
        suggestion: result.suggestion,
      })
    } else {
      keepCount++
    }
  }

  // Sort: noise first, then review; within each group by volumePct desc
  patterns.sort((a, b) => {
    if (a.classification !== b.classification) {
      return a.classification === 'noise' ? -1 : 1
    }
    return b.volumePct - a.volumePct
  })

  const potentialReductionPct =
    totalEvents > 0 ? Math.round((reducibleCount / totalEvents) * 1000) / 10 : 0

  return { patterns, totalPatternsAnalyzed: rows.length, noiseCount, reviewCount, keepCount, potentialReductionPct }
}

export function costRoutes(deps: CostDeps): Router {
  const router = Router()

  // Singular 'cost' (not plural like /deploys, /watches) — this URL names an
  // operation/report on the namespace, not a collection of cost entities.
  router.get('/cost/analysis', validateQuery(costAnalysisSchema), async (req, res, next) => {
    try {
      const tenantId = getTenantId(res)
      const params = getQuery<CostAnalysisQuery>(req)
      const settings = deps.settingsStore.get(tenantId)

      const thresholds: CostThresholds = {
        noiseDebugPct: settings.costNoiseDebugPct ?? DEFAULT_NOISE_DEBUG_PCT,
        reviewInfoPct: settings.costReviewInfoPct ?? DEFAULT_REVIEW_INFO_PCT,
        reviewWarnPct: settings.costReviewWarnPct ?? DEFAULT_REVIEW_WARN_PCT,
      }

      const rows = await queryCostAnalysis(deps.db, tenantId, {
        hours: params.hours,
        service: params.service,
        level: params.level,
      })

      const { patterns, totalPatternsAnalyzed, noiseCount, reviewCount, keepCount, potentialReductionPct } =
        buildPatterns(rows, thresholds)

      const data: CostAnalysisData = {
        summary: {
          totalPatternsAnalyzed,
          noiseCount,
          reviewCount,
          keepCount,
          potentialReductionPct,
        },
        patterns,
        thresholds,
      }

      respond(res, data, { hours: params.hours, count: patterns.length })
    } catch (err) {
      next(err)
    }
  })

  return router
}
