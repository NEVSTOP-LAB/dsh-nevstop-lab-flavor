/**
 * 本机 CPU / 内存占用的低开销采样。
 *
 * - CPU 用 `os.cpus()` 的累计时间做差：单次快照只是累计值，两次采样之间才有意义，
 *   所以第一次调用返回 `cpu: null`，之后每次都用「距上一次采样」的增量算占用。
 * - 内存优先读 Linux 的 `/proc/meminfo` 里的 `MemAvailable`（含可回收缓存，比
 *   `os.freemem()` 更接近"真正可用"）；读不到或非 Linux 时退回 `os.freemem()`。
 * - 不开定时器、不常驻采样：只在被调用时算一次，并按 `minIntervalMs` 复用上一次结果，
 *   避免浏览器侧轮询过密时重复读 `/proc`。
 */
import { cpus, freemem, platform, totalmem } from 'node:os'
import { readFile } from 'node:fs/promises'

const DEFAULT_MIN_INTERVAL_MS = 1000
const LINUX_MEMINFO = '/proc/meminfo'

/** 汇总全部逻辑核的累计时间（毫秒）。 */
function cpuSnapshot() {
  let idle = 0
  let total = 0
  for (const core of cpus()) {
    const times = core.times
    idle += times.idle
    total += times.user + times.nice + times.sys + times.idle + times.irq
  }
  return { idle, total }
}

/** 读系统内存总量与可用量（字节）。 */
async function memorySnapshot() {
  const total = totalmem()
  if (platform() === 'linux') {
    try {
      const text = await readFile(LINUX_MEMINFO, 'utf8')
      const matched = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text)
      if (matched !== null) {
        const available = Number(matched[1]) * 1024
        if (Number.isFinite(available) && available > 0 && available <= total) return { total, free: available }
      }
    } catch {
      // 容器里可能没有 /proc/meminfo，退回 os.freemem()。
    }
  }
  const free = freemem()
  return { total, free: free > 0 && free <= total ? free : Math.min(total, Math.max(0, free)) }
}

/**
 * 创建采样器。
 * @param {{ minIntervalMs?: number }} [options] 两次真实采样之间的最短间隔，默认 1 秒。
 * @returns {{ read: () => Promise<{ at: number, cpu: number | null, memory: { total: number, free: number, used: number, ratio: number | null } }> }} 采样器
 */
export function createUsageSampler(options = {}) {
  const minIntervalMs = Number.isFinite(options.minIntervalMs) && options.minIntervalMs > 0
    ? options.minIntervalMs
    : DEFAULT_MIN_INTERVAL_MS
  let previousCpu = null
  let lastAt = 0
  let last = null
  return {
    async read() {
      const now = Date.now()
      if (last !== null && now - lastAt < minIntervalMs) return last
      const current = cpuSnapshot()
      const memory = await memorySnapshot()
      let cpu = null
      if (previousCpu !== null) {
        const totalDelta = current.total - previousCpu.total
        const idleDelta = current.idle - previousCpu.idle
        if (totalDelta > 0) cpu = Math.min(1, Math.max(0, (totalDelta - idleDelta) / totalDelta))
      }
      previousCpu = current
      lastAt = now
      const used = Math.max(0, memory.total - memory.free)
      last = {
        at: now,
        cpu,
        memory: {
          total: memory.total,
          free: memory.free,
          used,
          ratio: memory.total > 0 ? Math.min(1, used / memory.total) : null,
        },
      }
      return last
    },
  }
}
