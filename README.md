# dsh-efforts-detector

A DSH plugin that puts each model's reasoning levels back into the profile after
a model import drops them. It reads the levels the endpoint itself publishes, so
it needs no per-vendor knowledge base: any gateway that advertises
`reasoning_levels` in its model listing is covered, whether the plugin has ever
heard of the model or not.

Formerly published as `dsh-reasoning-efforts`; the package, bundle entry, and
tool were renamed in 1.1.0 and the old name is no longer maintained.

## Install

From npm (the plain name works once published — nothing has to guess a GitHub
repository from a scope):

```text
plugin_manager install_bundle target: "dsh-efforts-detector"
```

Pinned to a release, or straight from this repository:

```text
plugin_manager install_bundle target: "dsh-efforts-detector@1.1.0"
plugin_manager install_bundle target: "github:codefoxs/dsh-efforts-detector#v1.1.0"
```

A `@scope/name` spec is NOT a shorthand for `github:scope/name`: pnpm reads it
as an npm package under that scope and fails with 404 unless it is actually
published there. Use `github:` when you mean GitHub.

Or from the plugin market, or by cloning this repository and passing its
directory as `target`. The bundle declares its own patch, so it inserts itself
and needs no hand edit of `cordis.patch.yml`; the only row it adds is
`efforts-detector` with `routes: []`, which means every eligible route.

Requires DSH with the `llm-pi-ai` plugin (the stock model provider layer). The
plugin imports nothing outside Node's built-ins, so it works wherever the
profile resolves it from.

## Why it is needed

DSH's "fetch available models" action keeps four fields from a provider listing —
`id`, `name`, `contextWindow`, `maxTokens` — and drops the rest. A route whose
listing publishes reasoning levels (`reasoning_levels`, `supported_reasoning_levels`)
therefore loses them on every import, and the reasoning selector falls back to
whatever the config happens to say.

This plugin reads the listing again and writes the levels back into each route's
`reasoningEfforts`, which is the only field DSH reads when it builds a model's
thinking levels. It is not tied to one gateway or one protocol: any route whose
endpoint publishes a model listing is covered — `openai-completions`,
`openai-responses`, `anthropic-messages`, `google-generative-ai`, and the codex
and azure variants — and by default every such route is synced.

Gateways that front several protocols usually serve one listing per host, and
the OpenAI-shaped reply is the one carrying reasoning levels. So the plugin
probes `{baseURL}/models`, `{baseURL}/v1/models`, and `{baseURL}/v1beta/models`
in that order, picks the credential header the route's protocol expects
(`Authorization: Bearer`, `x-api-key`, or `x-goog-api-key`), and keeps the first
reply that parses into a listing with at least one model. A Gemini route on such
a gateway therefore still gets its levels from the OpenAI-shaped listing.

## When it runs

- **Automatically**, two seconds after any change to the config document
  (`settings/document-updated` on `llm-pi-ai`), which covers an import from the
  models settings page.
- **Automatically**, when the profile's YAML files change on disk, which covers
  hand edits and edits made by other tools.
- **Automatically**, once shortly after the plugin starts.
- **On demand**, through the `efforts_detector_sync` tool: pass `dryRun: true`
  to see what would change without writing.

A run that finds nothing to change writes nothing, so the automatic trigger
cannot loop with its own write.

## What it writes

Only the seven levels DSH can select are used, and a level keeps the provider's
own name whenever DSH has a slot for it:

| Provider level | Written as | Effect in DSH |
| --- | --- | --- |
| `none` | `off: "none"` | the "off" choice sends `reasoning_effort: "none"` |
| `off` | `off: null` | the "off" choice sends no effort field |
| `minimal` … `xhigh` | same name | selectable at that level |
| `ultra` | `max: "ultra"` | the "max" choice sends `ultra` |
| `max` | `max: "max"` | the "max" choice sends `max` |

`ultra` has no slot of its own, so it takes the `max` slot; when a listing offers
both, `max` becomes unreachable from the selector. Any other level a provider
invents is ignored rather than renamed.

Models the listing does not describe, and models whose listing advertises no
usable level (image and video models), are left exactly as they are.

## Configuration

The plugin row in `cordis.patch.yml` takes:

```yaml
- id: efforts-detector
  name: 'dsh-efforts-detector'
  config:
    routes: []         # route keys under llm-pi-ai.providers; empty = every eligible route
    auto: true         # run on config changes
    onStart: true      # run once at startup
    debounceMs: 2000   # wait this long after a change before running
```

A route is eligible when it has a non-empty `models` list, a `baseURL`, and an
`api` this plugin can talk to. Naming routes explicitly is only needed to exclude
one, or to pin the plugin to a single gateway.

## Protocols

| `api` | Listing tried | Credential header |
| --- | --- | --- |
| `openai-completions`, `openai-responses`, `openai-codex`, `openai-codex-responses`, `azure-openai-responses` | `/models`, `/v1/models`, `/v1beta/models` | `Authorization: Bearer` |
| `anthropic-messages` | same, in that order | `x-api-key` + `anthropic-version` |
| `google-generative-ai` | same, in that order | `x-goog-api-key` |

A reply may be OpenAI-shaped (`{"data":[{ "id": … }]}`), Anthropic-shaped (the
same `data` array), or Gemini-shaped (`{"models":[{"name":"models/…"}]}`); the
`models/` prefix is stripped so ids match the config. If the protocol's own
header is rejected with 401/403, the plugin retries once with every accepted
header spelling before moving to the next URL. The tool reports which URL
answered, so a misconfigured route is visible instead of silently empty.

## Limits

- The listing must return the levels; a stock OpenAI or Anthropic listing has
  nothing to copy, and a Gemini-native `/v1beta/models` reply carries no levels
  at all. On a gateway that serves an OpenAI-shaped listing as well, that reply
  wins and the levels are available.
- Writes go through the settings service, so they land in the same document the
  models page edits and only inside the volatile `providers` subtree. If the
  document changes while a sync is writing, the sync rebuilds its plan and
  retries.
- The plugin adds one network request per route per run — usually one, at most
  a handful while probing. It sends no model names or prompts.
- Turning the plugin off stops the backfill; existing `reasoningEfforts` values
  stay in the config.
