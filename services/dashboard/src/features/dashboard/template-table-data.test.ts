import { describe, expect, it } from 'vitest'
import type { TemplateRow } from '../../api/types'
import {
  countHidden,
  filterVisibleTemplates,
  matchesTemplateSearch,
  staleHiddenIds,
  topSparklineIds,
} from './template-table-data'

function row(overrides: Partial<TemplateRow> = {}): TemplateRow {
  return {
    templateId: 't1',
    templateText: 'GET /api/users <NUM>',
    service: 'api',
    occurrenceCount: 100,
    errorCount: 0,
    avgDurationMs: 12,
    maxAnomalyScore: 0,
    isNewToday: false,
    firstSeen: '2026-07-03T00:00:00Z',
    lastSeen: '2026-07-03T01:00:00Z',
    ...overrides,
  }
}

describe('filterVisibleTemplates', () => {
  const templates = [row({ templateId: 'a' }), row({ templateId: 'b' }), row({ templateId: 'c' })]

  it('removes hidden templates by default', () => {
    const out = filterVisibleTemplates(templates, {
      hiddenIds: ['b'],
      showHidden: false,
      watchedOnly: false,
      watchedIds: new Set(),
    })
    expect(out.map((t) => t.templateId)).toEqual(['a', 'c'])
  })

  it('keeps hidden templates when showHidden is on', () => {
    const out = filterVisibleTemplates(templates, {
      hiddenIds: ['b'],
      showHidden: true,
      watchedOnly: false,
      watchedIds: new Set(),
    })
    expect(out.map((t) => t.templateId)).toEqual(['a', 'b', 'c'])
  })

  it('restricts to watched templates when watchedOnly is on', () => {
    const out = filterVisibleTemplates(templates, {
      hiddenIds: [],
      showHidden: false,
      watchedOnly: true,
      watchedIds: new Set(['a', 'c']),
    })
    expect(out.map((t) => t.templateId)).toEqual(['a', 'c'])
  })

  it('applies hidden and watchedOnly filters together', () => {
    // 'a' is watched but hidden -> dropped; 'c' is watched and visible -> kept.
    const out = filterVisibleTemplates(templates, {
      hiddenIds: ['a'],
      showHidden: false,
      watchedOnly: true,
      watchedIds: new Set(['a', 'c']),
    })
    expect(out.map((t) => t.templateId)).toEqual(['c'])
  })

  it('does not mutate the input', () => {
    const snapshot = templates.map((t) => t.templateId)
    filterVisibleTemplates(templates, {
      hiddenIds: ['a'],
      showHidden: false,
      watchedOnly: false,
      watchedIds: new Set(),
    })
    expect(templates.map((t) => t.templateId)).toEqual(snapshot)
  })
})

describe('topSparklineIds', () => {
  it('returns ids ranked by anomaly score descending', () => {
    const templates = [
      row({ templateId: 'low', maxAnomalyScore: 0.1 }),
      row({ templateId: 'high', maxAnomalyScore: 0.9 }),
      row({ templateId: 'mid', maxAnomalyScore: 0.5 }),
    ]
    expect(topSparklineIds(templates)).toEqual(['high', 'mid', 'low'])
  })

  it('caps the result at the limit', () => {
    const templates = Array.from({ length: 30 }, (_, i) =>
      row({ templateId: `t${i}`, maxAnomalyScore: i }),
    )
    expect(topSparklineIds(templates, 20)).toHaveLength(20)
    // Highest score (t29) is first.
    expect(topSparklineIds(templates, 20)[0]).toBe('t29')
  })

  it('does not mutate the input order', () => {
    const templates = [
      row({ templateId: 'a', maxAnomalyScore: 0.1 }),
      row({ templateId: 'b', maxAnomalyScore: 0.9 }),
    ]
    topSparklineIds(templates)
    expect(templates.map((t) => t.templateId)).toEqual(['a', 'b'])
  })

  it('returns an empty array for no templates', () => {
    expect(topSparklineIds([])).toEqual([])
  })
})

describe('matchesTemplateSearch', () => {
  it('matches on template text, case-insensitively', () => {
    expect(matchesTemplateSearch(row({ templateText: 'Connection TIMED out' }), 'timed')).toBe(true)
  })

  it('matches on service name', () => {
    expect(matchesTemplateSearch(row({ service: 'billing' }), 'bill')).toBe(true)
  })

  it('returns false when neither field contains the query', () => {
    expect(matchesTemplateSearch(row({ templateText: 'foo', service: 'api' }), 'zzz')).toBe(false)
  })

  it('matches everything on an empty query', () => {
    expect(matchesTemplateSearch(row(), '')).toBe(true)
  })
})

describe('staleHiddenIds', () => {
  it('returns hidden ids no longer present in the template set', () => {
    const templates = [row({ templateId: 'a' }), row({ templateId: 'b' })]
    expect(staleHiddenIds(templates, ['a', 'gone', 'b', 'also-gone'])).toEqual([
      'gone',
      'also-gone',
    ])
  })

  it('returns empty when all hidden ids still exist', () => {
    const templates = [row({ templateId: 'a' })]
    expect(staleHiddenIds(templates, ['a'])).toEqual([])
  })

  it('returns empty when there are no templates yet (avoids pruning during load)', () => {
    expect(staleHiddenIds([], ['a', 'b'])).toEqual([])
  })

  it('returns empty when nothing is hidden', () => {
    expect(staleHiddenIds([row({ templateId: 'a' })], [])).toEqual([])
  })
})

describe('countHidden', () => {
  it('counts current templates that are hidden', () => {
    const templates = [row({ templateId: 'a' }), row({ templateId: 'b' }), row({ templateId: 'c' })]
    expect(countHidden(templates, ['a', 'c', 'not-present'])).toBe(2)
  })

  it('is zero when nothing is hidden', () => {
    expect(countHidden([row({ templateId: 'a' })], [])).toBe(0)
  })
})
