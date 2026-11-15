/**
 * Backfill `reasoningEfforts` for pi-ai routes from the model listing each
 * route's own endpoint publishes.
 *
 * DSH's model import reads four fields (`id`, `name`, `contextWindow`,
 * `maxTokens`) and drops everything else, so a route configured through the
 * settings surface loses its reasoning levels on every import. A gateway's
 * listing already carries them (`reasoning_levels`), and this plugin copies
 * them back into the profile config.
 *
 * A route may speak any protocol DSH supports (`openai-completions`,
 * `openai-responses`, `anthropic-messages`, `google-generative-ai`, and the
 * codex/azure variants). Gateways that front several protocols usually serve
 * one listing on a single host, so the listing URL is probed and the credential
 * header is chosen per protocol; the richest reply wins, and that reply is the
 * one carrying reasoning levels.
 *
 * Only the seven levels DSH can select are written, and a level keeps the name
 * the provider uses unless DSH has no such name:
 *   - `none` becomes `off: "none"` (DSH sends `reasoning_effort: "none"`)
 *   - `ultra` takes the `max` slot (`max: "ultra"`)
 *   - `off`, when a provider names it, becomes `off: null` (send nothing)
 *
 * Writes go through `settings.mutate`, so they land in the same document the
 * settings surface edits and stay inside the volatile `providers` subtree.
 */

import { watch } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Settings namespace of the pi-ai plugin, which owns provider routes. */
const NS = 'llm-pi-ai'

/** Directory holding the profile's config documents, when it can be located. */
function configDirectory(ctx) {
  const base = ctx?.baseUrl
  if (typeof base === 'string' && base.startsWith('file:')) {
    try {
      const target = fileURLToPath(base)
      const trimmed = target.replace(/[\\/]+$/, '')
      // A base URL that ends in a separator already names the directory.
      return trimmed.length === target.length ? dirname(target) : trimmed
    } catch {
      // A URL that does not map to a path is not a reason to fail activation.
    }
  }
  const profile = process.env.DSH_PROFILE_DIR
  return typeof profile === 'string' && profile.length > 0 ? profile : undefined
}

/**
 * Protocols whose model listing this plugin knows how to read. The value names
 * the credential header the protocol expects; gateways that front several
 * protocols usually serve the same listing from one host, so the URL is probed
 * rather than assumed.
 */
const PROTOCOLS = new Map([
  ['openai-completions', 'bearer'],
  ['openai-responses', 'bearer'],
  ['openai-codex', 'bearer'],
  ['openai-codex-responses', 'bearer'],
  ['azure-openai-responses', 'bearer'],
  ['anthropic-messages', 'anthropic'],
  ['google-generative-ai', 'gemini'],
])

/** Listing paths to try, in the order that finds the richest reply first. */
const LISTING_PATHS = ['/models', '/v1/models', '/v1beta/models']

/** Levels whose DSH name equals the provider name. */
const PLAIN_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh']

/** Ceiling on a listing reply, mirroring pi-ai's own discovery limit. */
const MAX_BYTES = 4 * 1024 * 1024

/** Give up on a listing endpoint that does not answer within this window. */
const TIMEOUT_MS = 15000

/** Rebuild the plan at most this many times when another editor wins the race. */
const WRITE_ATTEMPTS = 8

export const inject = ['settings']

/**
 * Options are read straight off the entry's `config`, so the plugin imports
 * nothing but Node builtins and stays loadable from any install location.
 * `cordis.patch.yml` documents the keys; `apply` supplies the defaults.
 */

/** Narrow an unknown error to its message. */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Wait for a delay, used between conflict retries. */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** Accept a configured route list; an empty list means "every eligible route". */
function normalizeRoutes(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.length > 0)
}

/**
 * Whether a route can be synced at all: it must list models, name a base URL,
 * and speak a protocol whose model listing this plugin knows how to read.
 */
function isEligible(profile) {
  if (profile === null || typeof profile !== 'object') return false
  if (!Array.isArray(profile.models) || profile.models.length === 0) return false
  if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0) return false
  const api = typeof profile.api === 'string' ? profile.api : 'openai-completions'
  return PROTOCOLS.has(api)
}

/** Resolve the configured routes, or discover every eligible one. */
function resolveRoutes(settings, requested) {
  if (requested.length > 0) return requested
  const descriptor = settings.describe().find((row) => row.ns === NS)
  const providers = descriptor?.value?.providers
  if (providers === null || typeof providers !== 'object') return []
  return Object.keys(providers).filter((route) => isEligible(providers[route])).sort()
}

/** Read the reasoning levels a listing entry advertises. */
function levelsOf(entry) {
  const raw = entry?.reasoning_levels ?? entry?.supported_reasoning_levels
  if (!Array.isArray(raw)) return []
  return raw.filter((level) => typeof level === 'string').map((level) => level.toLowerCase())
}

/**
 * Turn a provider's level names into a `reasoningEfforts` map, keeping the
 * provider's own spelling wherever DSH has a slot for it.
 */
function effortsFor(levels) {
  const set = new Set(levels)
  const efforts = {}
  if (set.has('none')) efforts.off = 'none'
  else if (set.has('off')) efforts.off = null
  for (const level of PLAIN_LEVELS) if (set.has(level)) efforts[level] = level
  if (set.has('ultra')) efforts.max = 'ultra'
  else if (set.has('max')) efforts.max = 'max'
  return efforts
}

/** Order-insensitive signature of an efforts map, so equal maps never rewrite. */
function signature(value) {
  if (value === undefined) return ''
  if (value === false) return 'false'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  return Object.keys(value).sort()
    .map((key) => `${key}=${String(JSON.stringify(value[key]))}`)
    .join(';')
}

/** Resolve the API key a route names, when it names one. */
async function resolveKey(credentials, ref) {
  if (ref === undefined || ref === null) return undefined
  if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined
  try {
    const resolved = await credentials.resolve(ref)
    if (typeof resolved === 'string') return resolved
    if (resolved !== null && typeof resolved === 'object' && typeof resolved.value === 'string') return resolved.value
    return undefined
  } catch {
    return undefined
  }
}

/** Candidate listing URLs for a route, richest reply first. */
function listingUrls(baseURL) {
  const base = baseURL.replace(/\/+$/, '')
  const urls = []
  for (const path of LISTING_PATHS) {
    const url = `${base}${path}`
    if (!urls.includes(url)) urls.push(url)
  }
  return urls
}

/**
 * Credential headers to try for a protocol. The first set is what the protocol
 * expects; the second sends every accepted spelling, for gateways that front
 * several protocols behind one key.
 */
function authVariants(api, apiKey) {
  if (apiKey === undefined) return [{}]
  const bearer = { authorization: `Bearer ${apiKey}` }
  const anthropic = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  const gemini = { 'x-goog-api-key': apiKey }
  const kind = PROTOCOLS.get(api) ?? 'bearer'
  const primary = kind === 'anthropic' ? anthropic : kind === 'gemini' ? gemini : bearer
  const everything = { ...bearer, ...anthropic, ...gemini }
  return [primary, everything]
}

/** Pull the model rows out of a listing reply, whatever shape it uses. */
function rowsOf(body) {
  if (Array.isArray(body?.data)) return body.data
  if (Array.isArray(body?.models)) return body.models
  if (Array.isArray(body?.data?.models)) return body.data.models
  return []
}

/** Read a listing row's model id, dropping the `models/` prefix Gemini uses. */
function idOf(row) {
  const raw = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : undefined
  if (raw === undefined || raw.length === 0) return undefined
  return raw.startsWith('models/') ? raw.slice('models/'.length) : raw
}

/** Fetch one listing URL, returning its table or the reason it did not answer. */
async function fetchListing(url, headers) {
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (error) {
    return { table: new Map(), reason: `${url}: ${reasonOf(error)}`, retryAuth: false }
  }
  if (!response.ok) {
    return { table: new Map(), reason: `${url} answered ${response.status}`, retryAuth: response.status === 401 || response.status === 403 }
  }
  const text = await response.text()
  if (text.length > MAX_BYTES) return { table: new Map(), reason: `${url} answered more than ${MAX_BYTES} bytes`, retryAuth: false }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { table: new Map(), reason: `${url} did not answer JSON`, retryAuth: false }
  }
  const table = new Map()
  for (const row of rowsOf(body)) {
    const id = idOf(row)
    if (id !== undefined && !table.has(id)) table.set(id, levelsOf(row))
  }
  return { table, reason: table.size === 0 ? `${url} listed no models` : undefined, retryAuth: false }
}

/**
 * Read a route's listing. Gateways commonly serve the OpenAI-shaped listing on
 * one host for every protocol they front, and that listing carries the reasoning
 * levels, so the URL is probed instead of derived from the protocol alone.
 */
async function listModels(profile, credentials) {
  const baseURL = typeof profile?.baseURL === 'string' ? profile.baseURL : ''
  if (baseURL.length === 0) throw new Error('this route sets no baseURL, so its models cannot be listed')
  const api = typeof profile?.api === 'string' ? profile.api : 'openai-completions'
  if (!PROTOCOLS.has(api)) throw new Error(`pi-ai protocol "${api}" has no model listing this plugin reads`)
  const apiKey = await resolveKey(credentials, typeof profile?.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined)
  const reasons = []
  for (const url of listingUrls(baseURL)) {
    for (const headers of authVariants(api, apiKey)) {
      const result = await fetchListing(url, headers)
      if (result.table.size > 0) return { table: result.table, url }
      reasons.push(result.reason)
      if (!result.retryAuth) break
    }
  }
  throw new Error(`no listing answered for ${baseURL} (${reasons.slice(-3).join('; ')})`)
}

/** Compare the configured models against the listing and build the pending writes. */
function buildPlan(route, models, table) {
  const ops = []
  const changes = []
  const missing = []
  const unmapped = []
  let unchanged = 0
  models.forEach((model, index) => {
    const id = typeof model?.id === 'string' ? model.id : undefined
    if (id === undefined) return
    const levels = table.get(id)
    if (levels === undefined) { missing.push(id); return }
    const efforts = effortsFor(levels)
    if (Object.keys(efforts).length === 0) { unmapped.push(id); return }
    if (signature(model.reasoningEfforts) === signature(efforts)) { unchanged += 1; return }
    changes.push({ id, from: model.reasoningEfforts === undefined ? null : model.reasoningEfforts, to: efforts })
    ops.push({ op: 'set', path: ['providers', route, 'models', String(index), 'reasoningEfforts'], value: efforts })
  })
  return { ops, changes, missing, unmapped, unchanged }
}

/** Whether a failed write lost a revision race with another editor. */
function isConflict(error) {
  const name = error?.name
  if (name === 'SettingsConflictError') return true
  return /revision|conflict/i.test(reasonOf(error))
}

/**
 * True while another HMR transaction owns the config document. A write attempted
 * from inside one is rejected outright, and the window is short, so the caller
 * waits and tries again instead of reporting a failure.
 */
function isBusy(error) {
  return /HMR transactions cannot be nested|HMR is disposed/i.test(reasonOf(error))
}

/**
 * Run work outside any HMR transaction inherited from the caller's async
 * context. A timer or watcher created inside a config transaction keeps that
 * context, and a settings write made from such a callback is rejected as a
 * nested transaction even though the original transaction has long finished.
 */
function outsideTransaction(ctx, run) {
  let hmr
  try {
    hmr = ctx.get?.('hmr')
  } catch {
    hmr = undefined
  }
  const store = hmr?.executing
  if (store !== undefined && typeof store.exit === 'function') return store.exit(run)
  return run()
}

/** Sync one route, rebuilding the plan when another editor changes the document first. */
async function syncRoute(settings, credentials, route, options) {
  const report = {
    route, listing: 0, listingUrl: undefined, applied: false, unchanged: 0, changed: [], missing: [], unmapped: [], error: undefined,
  }
  let descriptor = settings.describe().find((row) => row.ns === NS)
  if (descriptor === undefined) {
    report.error = `no configurable plugin entry "${NS}"`
    return report
  }
  const profile = descriptor.value?.providers?.[route]
  if (profile === undefined || profile === null) {
    report.error = `route "${route}" is not configured in ${NS}`
    return report
  }
  let listing
  try {
    listing = await listModels(profile, credentials)
  } catch (error) {
    report.error = reasonOf(error)
    return report
  }
  const table = listing.table
  report.listing = table.size
  report.listingUrl = listing.url
  let busy = false
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      await sleep(busy ? 700 : 600)
      descriptor = settings.describe().find((row) => row.ns === NS)
      if (descriptor === undefined) {
        report.error = `no configurable plugin entry "${NS}"`
        return report
      }
    }
    const models = descriptor.value?.providers?.[route]?.models
    const plan = buildPlan(route, Array.isArray(models) ? models : [], table)
    report.changed = plan.changes
    report.unchanged = plan.unchanged
    report.missing = plan.missing
    report.unmapped = plan.unmapped
    if (plan.ops.length === 0 || options.dryRun === true) return report
    try {
      await settings.mutate(NS, plan.ops, descriptor.revision)
      report.applied = true
      return report
    } catch (error) {
      if (!isConflict(error) && !isBusy(error)) {
        report.error = reasonOf(error)
        return report
      }
      busy = isBusy(error)
    }
  }
  report.error = busy
    ? 'the config editor stayed busy; run the sync again'
    : 'the config kept changing while writing; run the sync again'
  return report
}

/** Sync every requested route. */
async function syncRoutes(settings, credentials, routes, options = {}) {
  const results = []
  for (const route of routes) results.push(await syncRoute(settings, credentials, route, options))
  return results
}

/** Render an efforts map the way the config stores it. */
function describeEfforts(efforts) {
  if (efforts === null || efforts === undefined) return '(none)'
  if (typeof efforts !== 'object') return String(efforts)
  return Object.keys(efforts).map((key) => `${key}=${efforts[key] === null ? 'null' : efforts[key]}`).join(', ')
}

/** Project one route report onto the tool's output schema. */
function toToolRow(row) {
  const result = {
    route: row.route,
    listing: row.listing,
    applied: row.applied,
    unchanged: row.unchanged,
    changed: row.changed.map((item) => ({ id: item.id, to: describeEfforts(item.to) })),
    missing: row.missing,
    unmapped: row.unmapped,
  }
  if (row.listingUrl !== undefined) result.listingUrl = row.listingUrl
  if (row.error !== undefined) result.error = row.error
  return result
}

export function apply(ctx, config = {}) {
  const configured = normalizeRoutes(config.routes)
  const auto = config.auto !== false
  const onStart = config.onStart !== false
  const debounceMs = Number.isFinite(config.debounceMs) ? Math.max(250, config.debounceMs) : 2000
  const credentials = () => ctx.get('credentials')
  let timer
  let running = false
  let queued = false

  const note = (message) => {
    try {
      ctx.logger?.info?.(`[efforts-detector] ${message}`)
    } catch {
      // Logging is best effort; a logger that rejects the call must not fail a sync.
    }
  }

  const run = async (reason, options = {}) => {
    if (running) {
      queued = true
      return []
    }
    running = true
    try {
      const results = await outsideTransaction(ctx, async () => {
        const requested = resolveRoutes(ctx.settings, options.routes ?? configured)
        note(`${reason}: checking ${requested.length > 0 ? requested.join(', ') : 'no eligible route'}`)
        return syncRoutes(ctx.settings, credentials(), requested, options)
      })
      const changed = results.reduce((sum, row) => sum + row.changed.length, 0)
      const written = results.reduce((sum, row) => sum + (row.applied ? row.changed.length : 0), 0)
      const failures = results.filter((row) => row.error !== undefined)
      if (changed > 0 || failures.length > 0) {
        note(`${reason}: ${changed} model(s) ${options.dryRun === true || written === 0 ? 'pending' : 'updated'}`
          + (failures.length > 0 ? `; ${failures.map((row) => `${row.route}: ${row.error}`).join('; ')}` : ''))
      }
      return results
    } catch (error) {
      note(`${reason} failed: ${reasonOf(error)}`)
      return []
    } finally {
      running = false
      if (queued) {
        queued = false
        schedule('queued change')
      }
    }
  }

  const schedule = (reason) => {
    if (!auto) return
    clearTimeout(timer)
    timer = setTimeout(() => { void run(reason) }, debounceMs)
  }

  ctx.effect(() => {
    const dispose = ctx.on('settings/document-updated', (ns) => {
      if (ns === NS) schedule('config changed')
    })
    return () => {
      if (typeof dispose === 'function') dispose()
      clearTimeout(timer)
    }
  })

  // An edit made outside the settings surface (a hand-edited patch file, an
  // external tool) reaches the plugin only as a file change, so watch the
  // profile directory as well.
  ctx.effect(() => {
    const directory = configDirectory(ctx)
    note(`watching ${directory ?? '(no config directory found)'}`)
    if (directory === undefined) return () => {}
    let watcher
    try {
      watcher = watch(directory, { persistent: false }, (_event, name) => {
        if (name !== null && !/\.ya?ml$/i.test(String(name))) return
        schedule('config file changed')
      })
    } catch {
      return () => {}
    }
    return () => {
      try {
        watcher.close()
      } catch {
        // A watcher that is already closed needs no further release.
      }
    }
  })

  if (onStart) {
    ctx.effect(() => {
      const handle = setTimeout(() => { void run('activation') }, 2500)
      return () => { clearTimeout(handle) }
    })
  }

  ctx.inject(['tools'], (sctx) => {
    sctx.tools.register({
      name: 'efforts_detector_sync',
      description: 'Read the model listing of one or more pi-ai routes and write each model\'s reasoning levels back into its `reasoningEfforts`. Use it after importing models, or when a model\'s reasoning selector offers the wrong levels. Every route that publishes a model listing is synced unless specific routes are named. The plugin also runs this automatically whenever the config document changes.',
      parameters: {
        type: 'object',
        properties: {
          routes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Route keys to sync, such as ["magpie"]. Defaults to every route that publishes a model listing.',
          },
          dryRun: {
            type: 'boolean',
            description: 'Report the levels that would be written without changing the config.',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            routes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  route: { type: 'string' },
                  listing: { type: 'number' },
                  listingUrl: { type: 'string' },
                  applied: { type: 'boolean' },
                  unchanged: { type: 'number' },
                  changed: {
                    type: 'array',
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        id: { type: 'string' },
                        to: { type: 'string' },
                      },
                      required: ['id', 'to'],
                    },
                  },
                  missing: { type: 'array', items: { type: 'string' } },
                  unmapped: { type: 'array', items: { type: 'string' } },
                  error: { type: 'string' },
                },
                required: ['route', 'listing', 'applied', 'unchanged', 'changed', 'missing', 'unmapped'],
              },
            },
          },
          required: ['routes'],
        },
        render(args, value) {
          const lines = []
          for (const row of value.routes) {
            if (row.error !== undefined) {
              lines.push(`- ${row.route}: FAILED - ${row.error}`)
              continue
            }
            const via = row.listingUrl === undefined ? '' : ` via ${row.listingUrl.replace(/^https?:\/\//, '')}`
            const head = `${row.route}: ${row.listing} model(s) listed${via}, ${row.changed.length} `
              + `${row.applied ? 'updated' : 'to update'}, ${row.unchanged} already correct`
            lines.push(`- ${head}`)
            for (const item of row.changed) lines.push(`  - ${item.id} → ${item.to}`)
            if (row.missing.length > 0) lines.push(`  - not in the listing: ${row.missing.join(', ')}`)
            if (row.unmapped.length > 0) lines.push(`  - listing advertises no usable level: ${row.unmapped.join(', ')}`)
          }
          return [{ type: 'text', text: `Reasoning level sync:\n${lines.join('\n')}` }]
        },
      },
      async execute(args) {
        const requested = Array.isArray(args?.routes) && args.routes.length > 0 ? normalizeRoutes(args.routes) : configured
        const routes = resolveRoutes(ctx.settings, requested)
        const results = await syncRoutes(ctx.settings, credentials(), routes, { dryRun: args?.dryRun === true })
        return { routes: results.map(toToolRow) }
      },
    })
    note('registered the efforts_detector_sync tool')
  })
}

