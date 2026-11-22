import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { writeJsonAtomic } from './util.mjs'

export async function evaluateBlindCases({ adapterFactory, cases, outputPath = null }) {
  const rows = []
  const totals = {
    subjectChecks: 0,
    subjectCorrect: 0,
    semanticChecks: 0,
    semanticCorrect: 0,
    evidenceChecks: 0,
    evidenceCorrect: 0,
    purgeChecks: 0,
    purgeResiduals: 0,
  }
  for (const testCase of cases) {
    const adapter = await adapterFactory(testCase.id)
    await adapter.ingest(testCase.turn)
    const claims = await adapter.listClaims()
    const sourceClaims = claims.filter((claim) => claim.sourceTurnIds?.includes(testCase.turn.id))
    const checks = []
    for (const claim of sourceClaims) {
      totals.subjectChecks += 1
      const authority = claim.authority || claim.speaker
      const subjectCorrect = authority === testCase.expected.authority
        && claim.evidenceRefs?.every((ref) => ref.speaker === authority)
      totals.subjectCorrect += Number(subjectCorrect)
      checks.push({ kind: 'subject', claimId: claim.id, passed: subjectCorrect })
      totals.evidenceChecks += 1
      const evidenceCorrect = claim.evidenceRefs?.length > 0 && claim.evidenceRefs.every((ref) => {
        if (ref.turnId !== testCase.turn.id
          || !Number.isInteger(ref.start)
          || !Number.isInteger(ref.end)
          || ref.start < 0
          || ref.end <= ref.start
          || ref.end > testCase.turn.text.length) return false
        const quote = testCase.turn.text.slice(ref.start, ref.end)
        const quoteHash = createHash('sha256').update(quote).digest('hex')
        return quote === ref.quote && quoteHash === ref.quoteHash
      })
      totals.evidenceCorrect += Number(evidenceCorrect)
      checks.push({ kind: 'evidence-span-hash', claimId: claim.id, passed: evidenceCorrect })
      for (const field of ['polarity', 'modality', 'visibility']) {
        if (testCase.expected[field] === undefined) continue
        totals.semanticChecks += 1
        const passed = claim[field] === testCase.expected[field]
        totals.semanticCorrect += Number(passed)
        checks.push({ kind: field, claimId: claim.id, passed, actual: claim[field] ?? null })
      }
    }
    if (testCase.operation === 'purge-claim') {
      totals.purgeChecks += 1
      const target = sourceClaims[0]
      if (target) await adapter.purgeClaim(target.id)
      const afterPurge = await adapter.listClaims()
      const exported = await adapter.exportClaims()
      const present = afterPurge.some((claim) => claim.sourceTurnIds?.includes(testCase.turn.id))
        || exported.some((claim) => claim.sourceTurnIds?.includes(testCase.turn.id))
      totals.purgeResiduals += Number(present)
      checks.push({ kind: 'purge-claim-absent', passed: !present })
    }
    rows.push({ id: testCase.id, checks })
  }
  const subjectAccuracy = totals.subjectChecks ? totals.subjectCorrect / totals.subjectChecks : 1
  const semanticAccuracy = totals.semanticChecks ? totals.semanticCorrect / totals.semanticChecks : 1
  const evidenceAccuracy = totals.evidenceChecks ? totals.evidenceCorrect / totals.evidenceChecks : 1
  const purgeResidualRate = totals.purgeChecks ? totals.purgeResiduals / totals.purgeChecks : 0
  const passed = subjectAccuracy === 1
    && semanticAccuracy === 1
    && evidenceAccuracy === 1
    && purgeResidualRate === 0
  const report = {
    schema: 'companion-memory/independent-blind-evaluation@1',
    status: passed ? 'passed' : 'failed',
    source: 'external-fixture-and-generic-adapter-contract',
    totals,
    metrics: {
      subjectAccuracy,
      polarityModalityVisibilityAccuracy: semanticAccuracy,
      evidenceSpanHashAccuracy: evidenceAccuracy,
      purgeClaimResidualRate: purgeResidualRate,
    },
    physicalTurnErasure: 'not-tested-blocked-pending-privacy-review',
    cases: rows,
  }
  if (outputPath) await writeJsonAtomic(outputPath, report)
  return report
}

export async function loadBlindCases(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}
