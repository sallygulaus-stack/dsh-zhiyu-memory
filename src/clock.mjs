export class SimulatedClock {
  constructor(start = new Date()) {
    this.current = new Date(start)
    if (Number.isNaN(this.current.getTime())) throw new Error(`无效的起始时间：${start}`)
  }

  now() {
    return new Date(this.current)
  }

  iso() {
    return this.now().toISOString()
  }

  set(value) {
    const next = new Date(value)
    if (Number.isNaN(next.getTime())) throw new Error(`无效的时间：${value}`)
    this.current = next
    return this.now()
  }

  advance(milliseconds) {
    const amount = Number(milliseconds)
    if (!Number.isFinite(amount)) throw new Error(`无效的时间增量：${milliseconds}`)
    this.current = new Date(this.current.getTime() + amount)
    return this.now()
  }

  advanceHours(hours) {
    return this.advance(Number(hours) * 3_600_000)
  }

  advanceDays(days) {
    return this.advance(Number(days) * 86_400_000)
  }
}
