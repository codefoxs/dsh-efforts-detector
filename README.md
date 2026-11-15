# dsh-efforts-detector

A DSH plugin that puts each model's reasoning levels back into the profile after
a model import drops them. It reads the levels the endpoint itself publishes, so
it needs no per-vendor knowledge base: any gateway that advertises
`reasoning_levels` in its model listing is covered, whether the plugin has ever
heard of the model or not.

Formerly published as `dsh-reasoning-efforts`; the package, bundle entry, and
tool were renamed in 1.1.0 and the old name is no longer maintained.

## Install

### DSH Desktop

1. Open **Settings → Plugins**.
2. Pick **Installed** and use the install field there (**Install from npm or
   GitHub**), or open the **Plugin Market** tab and paste the same spec into its
   search box.
3. Enter `@codefoxs/dsh-efforts-detector` and install.

The app writes the package into the Desktop profile
(`~/.dsh/profiles/desktop`) and activates it without a restart — the entry
`efforts-detector` shows up under **Installed** and is already syncing. Nothing
in `cordis.patch.yml` needs a hand edit: the bundle carries its own patch, and
the only row it inserts is `efforts-detector` with `routes: []`.

If Desktop is set to the China download region, the install goes through
`registry.npmmirror.com`. A version published minutes ago can still be missing
there while the mirror catches up; retry, or install from GitHub for that one
version (see below).

### Command line or `dsh web`

`plugin_manager` is the same installer the app calls — use whichever you have:

```text
plugin_manager install_bundle target: "@codefoxs/dsh-efforts-detector"
```

Pinned to the latest release, or straight from the repository (no registry at all):

```text
plugin_manager install_bundle target: "@codefoxs/dsh-efforts-detector@1.1.1"
plugin_manager install_bundle target: "github:codefoxs/dsh-efforts-detector#v1.1.1"
```

A local checkout works too: pass its absolute directory as `target`, which is
what a development loop looks like (a `link:` install follows the working tree,
so `set_plugin` disabled then enabled reloads your edits).

### What `@scope/name` does and does not mean

`@codefoxs/dsh-efforts-detector` is an npm package name, not a shorthand for
the GitHub repository `codefoxs/dsh-efforts-detector`. pnpm reads a scoped name
as a registry lookup and fails with 404 unless the package is published there;
only `github:`, `gitlab:` and `bitbucket:` route to git. Use `github:` when you
mean GitHub, and the plain scoped name when you mean npm.

### Requirements

A DSH installation with the `llm-pi-ai` plugin — the stock model provider
layer, present in every profile. The plugin imports nothing but Node's built-in
modules, so it activates wherever the profile resolves it from, including a
`link:` install of a local checkout.

## Usage

Out of the box nothing has to be clicked: the plugin syncs on its own after an
import, after an edit in Settings → Models, and after the config file is
written from outside DSH (`## When it runs` has the exact triggers). That is the
whole point — "fetch available models" keeps four fields from the listing
(`id`, `name`, `contextWindow`, `maxTokens`) and drops the reasoning levels,
and this puts them back within seconds.

To force a pass, call the `efforts_detector_sync` tool from the agent, or:

```text
efforts_detector_sync({ dryRun: true })        # report what would change
efforts_detector_sync()                        # apply it
efforts_detector_sync({ routes: ["magpie"] })  # one route only
```

`routes` defaults to every eligible route: a route with a non-empty `models`
list, a `baseURL`, and an `api` the plugin knows how to talk to. The bundle's own
config sets `routes: []`, which means the same thing as omitting it.

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
