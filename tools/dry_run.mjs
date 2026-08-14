// Dry run for a workflow script: execute the real control flow with agent() stubbed out.
//
// Why this exists: a workflow script only fails at the point it reaches, and it reaches the
// end 20 minutes and half a million tokens later. `SOURCE_PATHS is not defined` sat in the
// final return statement and cost a whole run; neither node --check (which parses a .js with
// `export` as CommonJS and stays silent) nor the IDE's diagnostics (an undeclared global is
// valid JavaScript) saw it.
//
// The stub answers every agent() call with a value built from its own schema, so every branch
// the script takes is real code running against real data shapes. Two modes: "ok" drives the
// happy path, "bad" makes every boolean false so the retry, unresolved and gate-failure
// branches execute too.
//
// Usage: node tools/dry_run.mjs <script.js> [ok|bad] ['{"runDir":"dry/run",...}']
//
// The third argument is the `args` the script receives, as JSON. Scripts that validate
// their input reject the default, and that rejection is itself worth exercising.

import { readFileSync } from 'node:fs'

const [, , target, mode = 'ok', argsJson] = process.argv
const runArgs = argsJson ? JSON.parse(argsJson) : { runDir: 'dry/run' }
const happy = mode !== 'bad'

const source = readFileSync(target, 'utf8').replace(/^export\s+const\s+meta/m, 'const meta')

function pathsFromPrompt(prompt) {
  const found = [...prompt.matchAll(/^\s*\d+\.\s+(\S+\.(?:md|txt|png))\s*$/gm)].map((m) => m[1])
  return found.length ? found : ['dry/run/unknown.md']
}

function fill(schema, prompt) {
  if (!schema || typeof schema !== 'object') return 'x'
  if (Array.isArray(schema.enum)) {
    return happy ? schema.enum[0] : schema.enum[schema.enum.length - 1]
  }
  switch (schema.type) {
    case 'boolean':
      return happy
    case 'number':
    case 'integer':
      return 1
    case 'array': {
      const n = Math.max(schema.minItems ?? 1, 1)
      return Array.from({ length: n }, () => fill(schema.items, prompt))
    }
    case 'object': {
      const out = {}
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        // A `checks` array is filled from its own item schema, not from a hardcoded shape:
        // different stages report different fields. Only a `path` property gets special
        // treatment, echoing the paths the prompt listed so lookups by path still match.
        if (key === 'checks' && sub && sub.type === 'array') {
          const item = sub.items ?? {}
          const props = item.properties ?? {}
          if (props.path) {
            out[key] = pathsFromPrompt(prompt).map((p) => ({
              ...fill(item, prompt),
              path: p,
              problems: happy ? [] : [`output missing: ${p}`],
            }))
          } else {
            out[key] = fill(sub, prompt)
          }
          continue
        }
        if (key === 'problems') {
          out[key] = happy ? [] : ['max_prose 9000 exceeded (got 9263)']
          continue
        }
        if (key === 'stdout') {
          out[key] = '{\n  "ok": true,\n  "problems": [],\n  "measures": {}\n}'
          continue
        }
        if (key === 'measures') {
          out[key] = { chars: 9351, prose_chars: 9263 }
          continue
        }
        out[key] = fill(sub, prompt)
      }
      return out
    }
    default:
      return 'x'
  }
}

const calls = []
const logs = []

const stubs = {
  args: runArgs,
  agent: async (prompt, opts = {}) => {
    calls.push(opts.label ?? '(no label)')
    if (typeof prompt !== 'string') throw new Error(`prompt is ${typeof prompt}, not a string`)
    if (prompt.includes('undefined')) {
      throw new Error(`prompt for "${opts.label}" contains the literal "undefined"`)
    }
    return fill(opts.schema, prompt)
  },
  parallel: async (thunks) => Promise.all(thunks.map((t) => t())),
  pipeline: async (items, ...stages) => {
    const out = []
    for (const [i, item] of items.entries()) {
      let value = item
      for (const stage of stages) value = await stage(value, item, i)
      out.push(value)
    }
    return out
  },
  log: (message) => logs.push(message),
  phase: () => {},
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const run = new AsyncFunction(...Object.keys(stubs), source)

try {
  const result = await run(...Object.values(stubs))
  console.log(`MODE ${mode}: скрипт дошёл до конца, агентов ${calls.length}`)
  console.log(`агенты: ${calls.join(', ')}`)
  console.log('--- log() ---')
  for (const line of logs) console.log(line)
  console.log('--- return ---')
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(`MODE ${mode}: ПАДЕНИЕ — ${error.message}`)
  console.error(error.stack)
  process.exitCode = 1
}
