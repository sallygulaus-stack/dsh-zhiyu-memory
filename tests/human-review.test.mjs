import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HUMAN_REVIEW_SCHEMA,
  applyHumanReview,
  createHumanReviewManifest,
} from '../src/human-review.mjs'

function candidate(id, summary = `旧摘要 ${id}`) {
  return {
    id,
    kind: 'fact',
    summary,
    evidence: summary,
    sourceKind: 'puppet-memory',
    sourceFile: 'behavior/notes.jsonl',
    sourceTurnIds: [`turn_${id}`],
    visibility: 'evidence-only',
    epistemicStatus: 'candidate',
    migrationStatus: 'quarantined',
    deletionState: 'live',
    occurredAt: '2026-10-27T00:00:00.000Z',
    recordedAt: '2026-11-23T00:00:00.000Z',
  }
}

test('human review promotes only the exact reviewed candidates', () => {
  const memories = [candidate('a'), candidate('b')]
  const manifest = createHumanReviewManifest(memories, {
    reviewedAt: '2026-11-23T13:00:00.000Z',
  })
  assert.equal(manifest.schema, HUMAN_REVIEW_SCHEMA)
  assert.equal(manifest.count, 2)
  const result = applyHumanReview(memories, manifest, { now: '2026-11-23T13:01:00.000Z' })
  assert.equal(result[0].visibility, 'recallable')
  assert.equal(result[0].epistemicStatus, 'accepted')
  assert.equal(result[0].migrationStatus, 'human-reviewed')
  assert.equal(result[0].humanReview.reviewer, 'user')
  assert.equal(result[0].humanReview.machineEvidence, 'legacy-summary-without-verified-span')
  assert.equal(result[1].humanReview.reviewedAt, '2026-11-23T13:00:00.000Z')
})

test('human review refuses changed content and does not promote unrelated rows', () => {
  const memories = [candidate('a'), candidate('b')]
  const manifest = createHumanReviewManifest(memories.slice(0, 1), {
    reviewedAt: '2026-11-23T13:00:00.000Z',
  })
  const changed = [{ ...memories[0], summary: '被改过的摘要' }, memories[1]]
  assert.throws(() => applyHumanReview(changed, manifest), /内容已变化/u)
  const untouched = applyHumanReview(memories, manifest)
  assert.equal(untouched[1].visibility, 'evidence-only')
  assert.equal(untouched[1].migrationStatus, 'quarantined')
})

test('human review rejects a manifest that targets a non-quarantined claim', () => {
  const memory = candidate('a')
  const manifest = createHumanReviewManifest([memory])
  const promoted = { ...memory, visibility: 'recallable' }
  assert.throws(() => applyHumanReview([promoted], manifest), /不是可晋升的隔离候选/u)
})
