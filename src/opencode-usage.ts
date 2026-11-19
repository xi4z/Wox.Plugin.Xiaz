import { request as httpsRequest } from "https"

import { Context, PublicAPI } from "@wox-launcher/wox-plugin"

const DEFAULT_CACHE_TTL_SECONDS = 15
const DEFAULT_REQUEST_TIMEOUT_MS = 8000
const DEFAULT_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const DEFAULT_ENV_VAR = "OPENCODE_GO_API_KEY"
const PLAN_NAME = "Go"
const USER_AGENT = "wox-plugin-ai-quota/0.7.0"
const MAX_RESPONSE_BYTES = 1 << 20

export type OpencodeAvailability = "pending" | "unavailable" | "ready" | "error"
export type OpencodeWindowId = "rolling" | "weekly" | "monthly"

export const OPENCODE_DEFAULT_ENV_VAR = DEFAULT_ENV_VAR
export const OPENCODE_WINDOW_ORDER: OpencodeWindowId[] = ["rolling", "weekly", "monthly"]

export const OPENCODE_WARNING_MISSING_KEY = "missing-key"
export const OPENCODE_WARNING_INVALID_KEY = "invalid-key"
export const OPENCODE_WARNING_NOT_SUBSCRIBED = "not-subscribed"
export const OPENCODE_WARNING_QUERY_RATE_LIMITED = "query-rate-limited"
export const OPENCODE_WARNING_INCOMPLETE_USAGE = "incomplete-usage"
export const OPENCODE_WARNING_PARTIAL_USAGE = "partial-usage"

export interface OpencodeUsageWindow {
  id: OpencodeWindowId
  usedPercent: number
  remainingPercent: number
  limited: boolean
  resetsAt: number | null
}

export interface OpencodeUsageSnapshot {
  fetchedAt: number
  availability: OpencodeAvailability
  source: "api"
  planName: string | null
  envVar: string
  windows: OpencodeUsageWindow[]
  warnings: string[]
}

interface PluginSettings {
  cacheTtlSeconds: number
  envVar: string
  usageUrl: string
  requestTimeoutMs: number
}

interface CacheEntry {
  snapshot: OpencodeUsageSnapshot
}

interface UsageQueryOptions {
  forceRefresh?: boolean
}

interface JsonRequestOptions {
  method: "GET"
  url: string
  headers?: Record<string, string>
  timeoutMs: number
}

interface JsonResponse {
  status: number
  raw: string
}

/** An OpenCode answer the plugin can explain to the user, keyed by a warning code instead of a localized string. */
export interface OpencodeUsageError extends Error {
  readonly code: string
}

/**
 * Builds a warning-carrying error. A subclass would not survive the ES5 target
 * this plugin is bundled for: `instanceof` breaks on down-levelled Error
 * subclasses, so the code lives on a plain Error and is read back through
 * isOpencodeUsageError.
 */
export function opencodeUsageError(code: string): OpencodeUsageError {
  const error = new Error(code) as OpencodeUsageError
  error.name = "OpencodeUsageError"
  Object.defineProperty(error, "code", {
    value: code,
    enumerable: true,
    writable: false,
    configurable: true
  })
  return error
}

export function isOpencodeUsageError(value: unknown): value is OpencodeUsageError {
  return value instanceof Error && typeof (value as { code?: unknown }).code === "string"
}

export interface OpencodeUsageProvider {
  start(ctx: Context, api: PublicAPI): Promise<void>
  getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<OpencodeUsageSnapshot>
  refresh(ctx: Context, api: PublicAPI): Promise<OpencodeUsageSnapshot>
  invalidate(): void
}

/**
 * Reads the OpenCode Go allowance from https://opencode.ai/zen/go/v1/usage.
 *
 * The endpoint reports the subscription-wide rolling, weekly and monthly windows
 * as a used percentage (the upstream rounds it) plus the reset instant. The API
 * key comes from an environment variable, because the Go key is a plain secret
 * that the plugin never writes anywhere except the outbound Authorization header.
 */
export class CachedOpencodeUsageProvider implements OpencodeUsageProvider {
  private cache: CacheEntry | null = null
  private inflight: Promise<OpencodeUsageSnapshot> | null = null
  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private started = false

  async start(ctx: Context, api: PublicAPI): Promise<void> {
    if (this.started) {
      return
    }

    this.started = true
    this.triggerBackgroundRefresh(ctx, api)
  }

  invalidate(): void {
    this.cache = null
  }

  async getSnapshot(ctx: Context, api: PublicAPI, options?: UsageQueryOptions): Promise<OpencodeUsageSnapshot> {
    await this.start(ctx, api)

    if (options?.forceRefresh === true) {
      return this.refresh(ctx, api)
    }

    if (this.cache !== null) {
      return this.cache.snapshot
    }

    return this.refresh(ctx, api)
  }

  async refresh(ctx: Context, api: PublicAPI): Promise<OpencodeUsageSnapshot> {
    await this.start(ctx, api)
    return this.performRefresh(ctx, api)
  }

  private async loadSnapshot(ctx: Context, api: PublicAPI): Promise<OpencodeUsageSnapshot> {
    const settings = await this.readSettings(ctx, api)
    const key = readOpencodeApiKey(process.env, settings.envVar)

    if (key === null) {
      return createMissingKeySnapshot(settings.envVar)
    }

    try {
      const usage = await fetchOpencodeUsage(settings.usageUrl, key, settings.requestTimeoutMs)
      return {
        fetchedAt: Date.now(),
        availability: "ready",
        source: "api",
        planName: PLAN_NAME,
        envVar: settings.envVar,
        windows: usage.windows,
        warnings: usage.warnings
      }
    } catch (error) {
      const warning = isOpencodeUsageError(error) ? error.code : toErrorMessage(error)
      await log(api, ctx, "Warning", "Failed to read OpenCode Go usage: " + warning)
      return {
        ...createEmptyOpencodeSnapshot(settings.envVar),
        availability: isUnavailableError(error) ? "unavailable" : "error",
        warnings: [warning]
      }
    }
  }

  private async readSettings(ctx: Context, api: PublicAPI): Promise<PluginSettings> {
    return {
      cacheTtlSeconds: await readNumberSetting(api, ctx, "cacheTtlSeconds", DEFAULT_CACHE_TTL_SECONDS),
      envVar: resolveOpencodeEnvVar(await readStringSetting(api, ctx, "opencodeGoEnvVar", DEFAULT_ENV_VAR)),
      usageUrl: resolveOpencodeUsageUrl(process.env),
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS
    }
  }

  private triggerBackgroundRefresh(ctx: Context, api: PublicAPI): void {
    if (this.inflight !== null) {
      return
    }

    void this.performRefresh(ctx, api).catch(async error => {
      await log(api, ctx, "Warning", "Background OpenCode Go usage refresh failed: " + toErrorMessage(error))
    })
  }

  private async performRefresh(ctx: Context, api: PublicAPI): Promise<OpencodeUsageSnapshot> {
    if (this.inflight !== null) {
      return this.inflight
    }

    this.clearRefreshTimer()

    const task = this.readSettings(ctx, api).then(async () => {
      const snapshot = await this.loadSnapshot(ctx, api)
      this.cache = {
        snapshot: snapshot
      }
      return snapshot
    })

    this.inflight = task

    try {
      return await task
    } finally {
      this.inflight = null
      await this.scheduleNextRefresh(ctx, api)
    }
  }

  private async scheduleNextRefresh(ctx: Context, api: PublicAPI): Promise<void> {
    if (!this.started) {
      return
    }

    const settings = await this.readSettings(ctx, api)
    this.clearRefreshTimer()
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      this.triggerBackgroundRefresh(ctx, api)
    }, settings.cacheTtlSeconds * 1000)
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
  }
}

export function createEmptyOpencodeSnapshot(envVar = DEFAULT_ENV_VAR): OpencodeUsageSnapshot {
  return {
    fetchedAt: Date.now(),
    availability: "pending",
    source: "api",
    planName: PLAN_NAME,
    envVar: envVar,
    windows: [],
    warnings: []
  }
}

export function createMissingKeySnapshot(envVar: string): OpencodeUsageSnapshot {
  return {
    ...createEmptyOpencodeSnapshot(envVar),
    availability: "unavailable",
    warnings: [OPENCODE_WARNING_MISSING_KEY]
  }
}

export function shouldShowOpencodeResult(snapshot: OpencodeUsageSnapshot, filter: "all" | "codex" | "cursor" | "grok" | "claude" | "opencode"): boolean {
  if (snapshot.availability === "pending") {
    return false
  }

  if (filter === "opencode") {
    return true
  }

  if (filter !== "all") {
    return false
  }

  return snapshot.availability === "ready" || snapshot.availability === "error"
}

export function resolveOpencodeEnvVar(value: string | null | undefined): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim()
  }

  return DEFAULT_ENV_VAR
}

export function resolveOpencodeUsageUrl(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCODE_GO_USAGE_URL
  if (typeof override === "string" && override.trim().length > 0) {
    return override.trim()
  }

  return DEFAULT_USAGE_URL
}

/** Reads the Go API key from the configured environment variable, tolerating a stray Bearer prefix or quoted value. */
export function readOpencodeApiKey(env: NodeJS.ProcessEnv, envVar: string): string | null {
  const raw = env[envVar]
  if (typeof raw !== "string") {
    return null
  }

  let key = raw.trim()
  if (key.length === 0) {
    return null
  }

  if (key.slice(0, 7).toLowerCase() === "bearer ") {
    key = key.slice(7).trim()
  }

  if (key.length >= 2 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) {
    key = key.slice(1, key.length - 1).trim()
  }

  return key.length > 0 ? key : null
}

export function buildOpencodeHeaders(key: string): Record<string, string> {
  return {
    Authorization: "Bearer " + key,
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    "x-opencode-client": "cli"
  }
}

/**
 * Reads the `/zen/go/v1/usage` answer:
 *
 *   { "usage": { "rolling": { "status", "percent", "resetsAt" }, "weekly": {...}, "monthly": {...} } }
 *
 * A window is kept only when percent is 0-100, status is ok/rate-limited and
 * resetsAt parses; a payload without any usable window is reported as
 * incomplete instead of showing invented numbers.
 */
export function parseOpencodeUsage(value: unknown): { windows: OpencodeUsageWindow[]; warnings: string[] } {
  if (!isRecord(value) || !isRecord(value.usage)) {
    throw opencodeUsageError(OPENCODE_WARNING_INCOMPLETE_USAGE)
  }

  const usage = value.usage
  const windows: OpencodeUsageWindow[] = []
  let skipped = 0

  for (let index = 0; index < OPENCODE_WINDOW_ORDER.length; index += 1) {
    const id = OPENCODE_WINDOW_ORDER[index]
    const entry = usage[id]
    if (!isRecord(entry)) {
      skipped += 1
      continue
    }

    const percent = readNumber(entry.percent)
    const status = entry.status
    const resetsAt = readTimestamp(entry.resetsAt)
    if (percent === null || percent < 0 || percent > 100 || (status !== "ok" && status !== "rate-limited") || resetsAt === null) {
      skipped += 1
      continue
    }

    windows.push({
      id: id,
      usedPercent: percent,
      remainingPercent: clampPercent(100 - percent),
      limited: status === "rate-limited",
      resetsAt: resetsAt
    })
  }

  if (windows.length === 0) {
    throw opencodeUsageError(OPENCODE_WARNING_INCOMPLETE_USAGE)
  }

  return {
    windows: windows,
    warnings: skipped > 0 ? [OPENCODE_WARNING_PARTIAL_USAGE] : []
  }
}

export function listOpencodeWindows(windows: OpencodeUsageWindow[]): OpencodeUsageWindow[] {
  const ordered: OpencodeUsageWindow[] = []
  for (let orderIndex = 0; orderIndex < OPENCODE_WINDOW_ORDER.length; orderIndex += 1) {
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
      if (windows[windowIndex].id === OPENCODE_WINDOW_ORDER[orderIndex]) {
        ordered.push(windows[windowIndex])
      }
    }
  }

  return ordered
}

async function fetchOpencodeUsage(url: string, key: string, timeoutMs: number): Promise<{ windows: OpencodeUsageWindow[]; warnings: string[] }> {
  const response = await requestJson({
    method: "GET",
    url: url,
    headers: buildOpencodeHeaders(key),
    timeoutMs: timeoutMs
  })

  if (response.status === 401) {
    throw opencodeUsageError(OPENCODE_WARNING_INVALID_KEY)
  }

  if (response.status === 403) {
    throw opencodeUsageError(OPENCODE_WARNING_NOT_SUBSCRIBED)
  }

  if (response.status === 429) {
    throw opencodeUsageError(OPENCODE_WARNING_QUERY_RATE_LIMITED)
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error("OpenCode usage request failed with HTTP " + String(response.status))
  }

  let json: unknown
  try {
    json = JSON.parse(response.raw) as unknown
  } catch {
    throw opencodeUsageError(OPENCODE_WARNING_INCOMPLETE_USAGE)
  }

  return parseOpencodeUsage(json)
}

function isUnavailableError(error: unknown): boolean {
  if (isOpencodeUsageError(error)) {
    return error.code === OPENCODE_WARNING_INVALID_KEY || error.code === OPENCODE_WARNING_NOT_SUBSCRIBED
  }

  return false
}

async function requestJson(options: JsonRequestOptions): Promise<JsonResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(options.url)
    const headers: Record<string, string | number> = {
      Accept: "application/json",
      "User-Agent": USER_AGENT
    }
    if (options.headers !== undefined) {
      const headerKeys = Object.keys(options.headers)
      for (let index = 0; index < headerKeys.length; index += 1) {
        headers[headerKeys[index]] = options.headers[headerKeys[index]]
      }
    }

    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: options.method,
        headers: headers
      },
      res => {
        const chunks: Buffer[] = []
        let total = 0
        res.on("data", (chunk: Buffer) => {
          total += chunk.length
          if (total > MAX_RESPONSE_BYTES) {
            req.destroy(new Error("OpenCode usage response is too large"))
            return
          }

          chunks.push(chunk)
        })
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            raw: Buffer.concat(chunks).toString("utf8")
          })
        })
      }
    )

    req.on("error", error => {
      reject(error instanceof Error ? error : new Error(String(error)))
    })

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error("Timed out while waiting for the OpenCode usage API"))
    })

    req.end()
  })
}

function readTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value > 1e12 ? value / 1000 : value)
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : Math.round(parsed / 1000)
  }

  return null
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function clampPercent(value: number): number {
  if (value < 0) {
    return 0
  }

  if (value > 100) {
    return 100
  }

  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readStringSetting(api: PublicAPI, ctx: Context, key: string, fallback: string): Promise<string> {
  if (typeof api.GetSetting !== "function") {
    return fallback
  }

  try {
    const value = await api.GetSetting(ctx, key)
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  } catch {
    return fallback
  }

  return fallback
}

async function readNumberSetting(api: PublicAPI, ctx: Context, key: string, fallback: number): Promise<number> {
  const raw = await readStringSetting(api, ctx, key, "")
  if (raw.length === 0) {
    return fallback
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }

  return parsed
}

async function log(api: PublicAPI, ctx: Context, level: "Info" | "Warning" | "Error" | "Debug", message: string): Promise<void> {
  if (typeof api.Log !== "function") {
    return
  }

  try {
    await api.Log(ctx, level, message)
  } catch {
    // Logging must never break usage rendering.
  }
}
