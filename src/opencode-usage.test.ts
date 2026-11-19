import {
  buildOpencodeHeaders,
  createEmptyOpencodeSnapshot,
  createMissingKeySnapshot,
  isOpencodeUsageError,
  listOpencodeWindows,
  OPENCODE_DEFAULT_ENV_VAR,
  OPENCODE_WARNING_INCOMPLETE_USAGE,
  OPENCODE_WARNING_MISSING_KEY,
  parseOpencodeUsage,
  readOpencodeApiKey,
  resolveOpencodeEnvVar,
  resolveOpencodeUsageUrl,
  shouldShowOpencodeResult
} from "./opencode-usage"
import { includesProvider, resolveUsageFilter } from "./index"

const ROLLING_RESET = "2026-11-19T14:05:00.000Z"
const WEEKLY_RESET = "2026-11-24T00:00:00.000Z"
const MONTHLY_RESET = "2026-12-01T00:00:00.000Z"

function parseErrorCode(run: () => void): string | null {
  try {
    run()
    return null
  } catch (error) {
    return isOpencodeUsageError(error) ? error.code : "unexpected:" + String(error)
  }
}

function goPayload() {
  return {
    usage: {
      rolling: { status: "ok", percent: 42, resetsAt: ROLLING_RESET },
      weekly: { status: "ok", percent: 12, resetsAt: WEEKLY_RESET },
      monthly: { status: "rate-limited", percent: 97, resetsAt: MONTHLY_RESET }
    }
  }
}

describe("parseOpencodeUsage", () => {
  test("reads the three Go allowance windows", () => {
    const usage = parseOpencodeUsage(goPayload())

    expect(usage.warnings).toEqual([])
    expect(usage.windows).toEqual([
      { id: "rolling", usedPercent: 42, remainingPercent: 58, limited: false, resetsAt: Math.floor(Date.parse(ROLLING_RESET) / 1000) },
      { id: "weekly", usedPercent: 12, remainingPercent: 88, limited: false, resetsAt: Math.floor(Date.parse(WEEKLY_RESET) / 1000) },
      { id: "monthly", usedPercent: 97, remainingPercent: 3, limited: true, resetsAt: Math.floor(Date.parse(MONTHLY_RESET) / 1000) }
    ])
  })

  test("keeps usable windows and flags the payload as partial when one window is malformed", () => {
    const payload = goPayload()
    payload.usage.weekly = { status: "ok", percent: 140, resetsAt: WEEKLY_RESET }

    const usage = parseOpencodeUsage(payload)

    expect(usage.windows.map(window => window.id)).toEqual(["rolling", "monthly"])
    expect(usage.warnings).toEqual(["partial-usage"])
  })

  test("rejects a payload without any usable window instead of inventing numbers", () => {
    expect(parseErrorCode(() => parseOpencodeUsage({ usage: {} }))).toBe(OPENCODE_WARNING_INCOMPLETE_USAGE)
    expect(parseErrorCode(() => parseOpencodeUsage({}))).toBe(OPENCODE_WARNING_INCOMPLETE_USAGE)
    expect(parseErrorCode(() => parseOpencodeUsage(null))).toBe(OPENCODE_WARNING_INCOMPLETE_USAGE)
    expect(parseErrorCode(() => parseOpencodeUsage({ usage: { rolling: { status: "ok", percent: 1, resetsAt: "not-a-date" } } }))).toBe(OPENCODE_WARNING_INCOMPLETE_USAGE)
  })

  test("accepts epoch resetsAt in seconds and milliseconds", () => {
    const seconds = parseOpencodeUsage({ usage: { rolling: { status: "ok", percent: 0, resetsAt: 1763560000 } } })
    expect(seconds.windows[0].resetsAt).toBe(1763560000)
    expect(seconds.windows[0].remainingPercent).toBe(100)

    const millis = parseOpencodeUsage({ usage: { rolling: { status: "ok", percent: 100, resetsAt: 1763560000000 } } })
    expect(millis.windows[0].resetsAt).toBe(1763560000)
    expect(millis.windows[0].remainingPercent).toBe(0)
  })

  test("skips a window with an unknown status and keeps the rest", () => {
    const usage = parseOpencodeUsage({
      usage: {
        rolling: { status: "paused", percent: 10, resetsAt: ROLLING_RESET },
        weekly: { status: "ok", percent: 10, resetsAt: WEEKLY_RESET }
      }
    })
    expect(usage.windows.map(window => window.id)).toEqual(["weekly"])
    expect(usage.warnings).toEqual(["partial-usage"])
  })
})

describe("readOpencodeApiKey", () => {
  test("reads the default environment variable", () => {
    expect(readOpencodeApiKey({ OPENCODE_GO_API_KEY: "sk-go-123" } as NodeJS.ProcessEnv, OPENCODE_DEFAULT_ENV_VAR)).toBe("sk-go-123")
  })

  test("trims whitespace, a Bearer prefix and quotes", () => {
    expect(readOpencodeApiKey({ KEY: "  sk-go-123  " } as NodeJS.ProcessEnv, "KEY")).toBe("sk-go-123")
    expect(readOpencodeApiKey({ KEY: "Bearer sk-go-123" } as NodeJS.ProcessEnv, "KEY")).toBe("sk-go-123")
    expect(readOpencodeApiKey({ KEY: '"sk-go-123"' } as NodeJS.ProcessEnv, "KEY")).toBe("sk-go-123")
  })

  test("reports a missing or empty variable", () => {
    expect(readOpencodeApiKey({} as NodeJS.ProcessEnv, "KEY")).toBeNull()
    expect(readOpencodeApiKey({ KEY: "   " } as NodeJS.ProcessEnv, "KEY")).toBeNull()
    expect(readOpencodeApiKey({ OTHER: "sk-go-123" } as NodeJS.ProcessEnv, "KEY")).toBeNull()
  })
})

describe("opencode settings helpers", () => {
  test("resolves the environment variable name", () => {
    expect(resolveOpencodeEnvVar(null)).toBe(OPENCODE_DEFAULT_ENV_VAR)
    expect(resolveOpencodeEnvVar("   ")).toBe(OPENCODE_DEFAULT_ENV_VAR)
    expect(resolveOpencodeEnvVar(" OPENCODE_TEAM_KEY ")).toBe("OPENCODE_TEAM_KEY")
  })

  test("defaults to the Go usage endpoint and honours an override", () => {
    expect(resolveOpencodeUsageUrl({} as NodeJS.ProcessEnv)).toBe("https://opencode.ai/zen/go/v1/usage")
    expect(resolveOpencodeUsageUrl({ OPENCODE_GO_USAGE_URL: " http://127.0.0.1:4567/usage " } as NodeJS.ProcessEnv)).toBe("http://127.0.0.1:4567/usage")
  })

  test("sends the key as a Go CLI bearer token", () => {
    expect(buildOpencodeHeaders("sk-go-123")).toEqual({
      Authorization: "Bearer sk-go-123",
      Accept: "application/json",
      "User-Agent": "wox-plugin-ai-quota/0.7.0",
      "x-opencode-client": "cli"
    })
  })
})

describe("opencode display helpers", () => {
  test("lists windows in rolling, weekly, monthly order", () => {
    const usage = parseOpencodeUsage(goPayload())
    const shuffled = [usage.windows[2], usage.windows[0], usage.windows[1]]

    expect(listOpencodeWindows(shuffled).map(window => window.id)).toEqual(["rolling", "weekly", "monthly"])
  })

  test("shows the row when the key is missing only for the explicit command", () => {
    const snapshot = createMissingKeySnapshot("OPENCODE_GO_API_KEY")

    expect(snapshot.availability).toBe("unavailable")
    expect(snapshot.warnings).toEqual([OPENCODE_WARNING_MISSING_KEY])
    expect(shouldShowOpencodeResult(snapshot, "all")).toBe(false)
    expect(shouldShowOpencodeResult(snapshot, "opencode")).toBe(true)
  })

  test("shows ready and failed snapshots in the combined list", () => {
    const pending = createEmptyOpencodeSnapshot()
    expect(shouldShowOpencodeResult(pending, "all")).toBe(false)
    expect(shouldShowOpencodeResult(pending, "opencode")).toBe(false)

    const ready = { ...createEmptyOpencodeSnapshot(), availability: "ready" as const }
    expect(shouldShowOpencodeResult(ready, "all")).toBe(true)

    const failed = { ...createEmptyOpencodeSnapshot(), availability: "error" as const, warnings: ["boom"] }
    expect(shouldShowOpencodeResult(failed, "all")).toBe(true)
    expect(shouldShowOpencodeResult(failed, "codex")).toBe(false)
  })
})

describe("provider filter", () => {
  test("routes the opencode command and search", () => {
    expect(resolveUsageFilter({ Search: "", Command: "opencode" })).toBe("opencode")
    expect(resolveUsageFilter({ Search: "opencode" })).toBe("opencode")
    expect(resolveUsageFilter({ Search: "opencode refresh" })).toBe("opencode")
    expect(resolveUsageFilter({ Search: "" })).toBe("all")
    expect(includesProvider("all", "opencode")).toBe(true)
    expect(includesProvider("opencode", "opencode")).toBe(true)
    expect(includesProvider("codex", "opencode")).toBe(false)
  })
})
