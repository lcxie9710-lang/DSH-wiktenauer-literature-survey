/**
 * Glossary store — bilingual term mapping persistence.
 *
 * Ported from `glossary_store.py` in the HEMA Question Agent project. Kept
 * self-contained (plain JSON file with atomic replace) so the plugin works
 * with zero extra configuration: no storage backend, no database, no server.
 * Each user's glossary is local to their Harness home.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Confidence delta applied on user confirm/reject. */
export const CONFIDENCE_DELTA = 0.3
/** Negative feedback threshold before a mapping is removed. */
export const NEGATIVE_FEEDBACK_THRESHOLD = 3

export type MappingSource =
  | 'llm_inferred'
  | 'user_confirmed'
  | 'expert_added'

export interface TermMapping {
  id: string
  source_term: string
  target_term: string
  source_language: string
  target_language: string
  confidence: number
  source: MappingSource
  created_at: string
  updated_at: string
  feedback_history: Array<{ timestamp: string; action: 'confirm' | 'reject'; user_correction: string | null }>
}

interface GlossaryFile {
  version: string
  last_updated: string
  mappings: TermMapping[]
  changelog: unknown[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function incrementVersion(version: string): string {
  const parts = version.split('.')
  parts[2] = String(Number(parts[2]) + 1)
  return parts.join('.')
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * A glossary persisted at one file path. Writes use temp-file + rename for
 * atomicity (same strategy as the Python original).
 */
export class GlossaryStore {
  private readonly path: string

  constructor(glossaryPath: string) {
    this.path = glossaryPath
    if (!existsSync(this.path)) {
      const dir = dirname(this.path)
      if (dir) mkdirSync(dir, { recursive: true })
      const initial: GlossaryFile = {
        version: '1.0.0',
        last_updated: nowIso(),
        mappings: [],
        changelog: [],
      }
      this.atomicWrite(initial)
    }
  }

  private atomicWrite(data: GlossaryFile): void {
    const dir = dirname(this.path) || '.'
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.glossary-${process.pid}-${Date.now()}.tmp`)
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmp, this.path)
  }

  private read(): GlossaryFile {
    const data = readJson<GlossaryFile>(this.path)
    if (!data || !Array.isArray(data.mappings)) {
      return { version: '1.0.0', last_updated: nowIso(), mappings: [], changelog: [] }
    }
    return data
  }

  /** All mappings for one source term, confirmed/expert first then by confidence. */
  lookup(term: string, sourceLang = 'zh'): TermMapping[] {
    const data = this.read()
    const matches = data.mappings.filter(
      m => m.source_term === term && m.source_language === sourceLang,
    )
    matches.sort((a, b) => {
      const pa = a.source === 'user_confirmed' || a.source === 'expert_added' ? 0 : 1
      const pb = b.source === 'user_confirmed' || b.source === 'expert_added' ? 0 : 1
      if (pa !== pb) return pa - pb
      return b.confidence - a.confidence
    })
    return matches
  }

  /** Render the prompt-context block for a set of terms (or all mappings). */
  getContextForPrompt(terms?: string[]): string {
    const data = this.read()
    let all = data.mappings
    if (terms !== undefined && terms.length > 0) {
      all = all.filter(m => terms.includes(m.source_term))
    }
    const confirmed = all.filter(m => m.source === 'user_confirmed' || m.source === 'expert_added')
    const inferred = all.filter(m => m.source === 'llm_inferred')

    const lines: string[] = ['=== 术语表上下文 ===']
    if (confirmed.length > 0) {
      lines.push('', '【已确认术语映射（可信）】')
      for (const m of confirmed) {
        lines.push(
          `  ${m.source_term} (${m.source_language}) → ${m.target_term} (${m.target_language}) [置信度: ${m.confidence.toFixed(2)}]`,
        )
      }
    }
    if (inferred.length > 0) {
      lines.push('', '【LLM 推断映射（待确认，可用但必须告知用户）】')
      for (const m of inferred) {
        lines.push(
          `  ${m.source_term} (${m.source_language}) → ${m.target_term} (${m.target_language}) [置信度: ${m.confidence.toFixed(2)}]`,
        )
      }
    }
    if (confirmed.length === 0 && inferred.length === 0) {
      lines.push('', '（术语表为空，无已知映射）')
    }
    lines.push('', '=== 术语表上下文结束 ===')
    return lines.join('\n')
  }

  /** Add a mapping; returns its id. */
  addMapping(input: Omit<TermMapping, 'id' | 'created_at' | 'updated_at' | 'feedback_history' | 'source'> & {
    id?: string
    source?: MappingSource
  }): string {
    const data = this.read()
    const mapping: TermMapping = {
      id: input.id ?? randomUUID(),
      source_term: input.source_term,
      target_term: input.target_term,
      source_language: input.source_language ?? 'zh',
      target_language: input.target_language ?? 'de',
      confidence: input.confidence ?? 0.5,
      source: input.source ?? 'llm_inferred',
      created_at: nowIso(),
      updated_at: nowIso(),
      feedback_history: [],
    }
    data.mappings.push(mapping)
    data.changelog.push({
      timestamp: nowIso(),
      change_type: 'addition',
      mapping_id: mapping.id,
      trigger: 'add_mapping',
    })
    data.version = incrementVersion(data.version)
    data.last_updated = nowIso()
    this.atomicWrite(data)
    return mapping.id
  }

  /** Confirm a mapping: confidence +0.3 (capped at 1.0), source → user_confirmed. */
  confirmMapping(mappingId: string): void {
    const data = this.read()
    const target = data.mappings.find(m => m.id === mappingId)
    if (!target) throw new Error(`Mapping not found: ${mappingId}`)
    target.confidence = Math.round(Math.min(target.confidence + CONFIDENCE_DELTA, 1.0) * 1e10) / 1e10
    target.source = 'user_confirmed'
    target.updated_at = nowIso()
    target.feedback_history.push({ timestamp: nowIso(), action: 'confirm', user_correction: null })
    data.changelog.push({
      timestamp: nowIso(),
      change_type: 'modification',
      mapping_id: mappingId,
      trigger: 'user_confirm',
    })
    data.version = incrementVersion(data.version)
    data.last_updated = nowIso()
    this.atomicWrite(data)
  }

  /** Reject a mapping: confidence -0.3; after 3 rejections the mapping is removed. */
  rejectMapping(mappingId: string): void {
    const data = this.read()
    const idx = data.mappings.findIndex(m => m.id === mappingId)
    if (idx < 0) throw new Error(`Mapping not found: ${mappingId}`)
    const target = data.mappings[idx]!
    target.confidence = Math.round(Math.max(target.confidence - CONFIDENCE_DELTA, 0.0) * 1e10) / 1e10
    target.updated_at = nowIso()
    target.feedback_history.push({ timestamp: nowIso(), action: 'reject', user_correction: null })
    const rejectCount = target.feedback_history.filter(f => f.action === 'reject').length
    if (rejectCount >= NEGATIVE_FEEDBACK_THRESHOLD) {
      data.mappings.splice(idx, 1)
      data.changelog.push({
        timestamp: nowIso(),
        change_type: 'removal',
        mapping_id: mappingId,
        trigger: 'negative_feedback_threshold',
      })
    } else {
      data.changelog.push({
        timestamp: nowIso(),
        change_type: 'modification',
        mapping_id: mappingId,
        trigger: 'user_reject',
      })
    }
    data.version = incrementVersion(data.version)
    data.last_updated = nowIso()
    this.atomicWrite(data)
  }

  /** All mappings (for the glossary command/UI). */
  all(): TermMapping[] {
    return this.read().mappings
  }
}
