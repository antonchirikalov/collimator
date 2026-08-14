// Same fingerprint proof as which-file.js, for every agent the pipeline used. The marker that
// emit_agents.py writes after the frontmatter exists in exactly one file per agent and nowhere
// else, so an agent quoting it verbatim is reading our generated definition as its system
// prompt. agentType in the run metadata only proves which name was requested; this proves
// which file answered.

export const meta = {
  name: 'which-file-all',
  description: 'Fingerprint every agent of the pipeline: is its prompt our generated file?',
  phases: [{ title: 'Fingerprint', detail: 'one cheap agent per definition' }],
}

const AGENTS = [
  'brief-writer',
  'source-finder',
  'domain-analyst',
  'article-writer',
  'example-verifier',
  'article-fact-checker',
  'article-critic',
  'style-critic-ru',
  'gate-runner',
  'verbatim-writer',
]

const PROOF = {
  type: 'object',
  required: ['html_comment', 'first_line', 'tools'],
  properties: {
    html_comment: {
      type: 'string',
      description: 'the HTML comment from your instructions, verbatim; empty string if none',
    },
    first_line: { type: 'string', description: 'the first line of instructions after it' },
    tools: { type: 'array', items: { type: 'string' }, description: 'the tools available to you' },
  },
}

phase('Fingerprint')
const proofs = await parallel(
  AGENTS.map((name) => () =>
    agent(
      'Diagnostics, not work. Read nothing from disk and write nothing — answer only about ' +
        'YOUR OWN instructions, the text handed to you as your system prompt.\n\n' +
        'Quote verbatim the HTML comment of the form <!-- ... --> if there is one; the first ' +
        'line of instructions after it; and the list of tools available to you.',
      { agentType: name, model: 'haiku', label: `fp:${name}`, phase: 'Fingerprint', schema: PROOF },
    ),
  ),
)

const report = []
for (let i = 0; i < AGENTS.length; i++) {
  const name = AGENTS[i]
  const p = proofs[i]
  if (!p) {
    log(`[fp/${name}] the agent did not answer`)
    continue
  }
  const expected = `library/agents/${name.replace(/-/g, '_')}/`
  const match = p.html_comment.includes(expected)
  log(`[fp/${name}] marker_is_ours=${match} tools=${p.tools.join(', ')}`)
  log(`[fp/${name}] comment=«${p.html_comment}»`)
  log(`[fp/${name}] first_line=«${p.first_line.slice(0, 120)}»`)
  report.push({ name, match, comment: p.html_comment, tools: p.tools })
}

return { report, all_ours: report.length === AGENTS.length && report.every((r) => r.match) }
