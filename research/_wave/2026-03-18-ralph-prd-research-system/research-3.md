# Research Report: Wave-Decompose Agent Specification

## Question
What is the wave-decompose agent's specification, and how does it transform `{N} {TOPIC}` into non-overlapping research questions with search hints?

---

## Findings

### Agent Identity & Metadata

The wave-decompose agent is defined in `vscode-config-files/agents/wave-decompose.agent.md` with the following frontmatter:

| Field | Value |
|-------|-------|
| `description` | "Decompose a research topic into N focused, non-overlapping questions for parallel codebase exploration." |
| `model` | Claude Opus 4.6 (fast mode) (Preview) (copilot) |
| `tools` | `[read, search]` — read-only, no write or terminal access |
| `user-invocable` | `false` — only callable as a subagent |
| `disable-model-invocation` | `false` |

### Input Protocol

The agent receives `$ARGUMENTS` parsed as:
- **First token** = `{N}` — the exact number of questions to generate (integer)
- **Remainder** = `{TOPIC}` — the research topic to decompose

Example: `6 silent retry patterns for 503 errors` → N=6, TOPIC="silent retry patterns for 503 errors"

### Decomposition Rules

The agent follows five explicit rules when splitting a topic:

1. **Non-overlapping coverage**: Each question targets a DIFFERENT file area, module, or angle
2. **Independent answerability**: Each question must be independently answerable by a single researcher agent
3. **Search hints required**: Every question includes likely file paths, function names, or grep patterns
4. **Specificity over vagueness**: Prefer "find X in Y" over "research how X works"
5. **Overflow strategy**: If the topic doesn't cleanly decompose into N parts, use extra slots for cross-validation questions

### Output Format

The agent produces a strictly structured output:

```
## Decomposition: {TOPIC} → {N} questions

1. {question} — hints: `{file/function/grep pattern}`
2. {question} — hints: `{file/function/grep pattern}`
...
N. {question} — hints: `{file/function/grep pattern}`
```

Key structural properties:
- Heading includes both topic and count for traceability
- Each line is a numbered question with inline search hints in backticks
- The hints use code formatting to distinguish them from the question text
- Exactly N lines are produced (no more, no less)

### Invocation Context

The orchestrator (`wave-orchestrator.agent.md`) invokes wave-decompose as the very first step in both **Aggregate Mode** and **Ralph PRD Mode**:

- **Aggregate Mode Step 1**: `Dispatch 1 wave-decompose subagent with {N} {TOPIC} as the prompt`
- **Ralph PRD Mode Phase 1**: Uses full Aggregate Mode flow which starts with decompose

The decompose output is consumed by the orchestrator to construct N parallel wave-researcher dispatches. Each researcher receives one question + its hints as its research prompt, along with a target file path for its report.

---

## Patterns

1. **Fan-out catalyst**: Wave-decompose is the single-point-of-entry that enables the entire parallel research pattern. It converts one broad topic into N independent work units — the classic scatter-gather / map-reduce fan-out.

2. **Tooling minimalism**: The agent has only `read` and `search` tools. It doesn't need to write files or run commands — its entire output is the structured question list returned to the orchestrator.

3. **Hint-driven targeting**: The search hints serve a dual purpose — they guide the downstream researcher agents AND they signal what the decompose agent itself considered when splitting the topic (provenance).

4. **Cross-validation overflow**: When N exceeds the natural partition count, extra questions become cross-validation probes. This prevents forced artificial splits and instead adds redundancy for verification.

5. **Strict output contract**: The numbered list format with inline hints is a pseudo-schema — simple enough to parse with string splitting, structured enough to be unambiguous. No JSON, no YAML — just markdown.

---

## Applicability

For the ralph-loop PRD research system:

- **Direct reuse**: The wave-decompose agent can be used as-is for ralph's research pipeline. Its input/output contract is clean and its rules are self-contained.
- **PRD integration**: In `--ralph-prd` mode, decompose feeds Phase 1 (Research Wave). The ContextBrief from Phase 0 is appended to each researcher's prompt but does NOT modify the decompose step itself.
- **Scalability**: N is capped at 12 by the orchestrator constraint, giving a maximum decomposition fan-out of 12 parallel researchers.
- **No state persistence**: Wave-decompose is stateless — it doesn't write files or maintain context. Its output flows entirely through the orchestrator's dispatch logic.

---

## Open Questions

1. **Quality variance**: How consistently does the LLM produce truly non-overlapping questions? Is there empirical data on overlap rates across different topic types?
2. **Hint accuracy**: Are the search hints validated against the actual workspace file structure, or are they best-effort suggestions that may point to non-existent paths?
3. **Cross-validation threshold**: At what N-to-natural-partition ratio does the "use extras for cross-validation" rule kick in? Is this left to LLM judgment?
4. **Topic complexity signal**: Should overly broad topics that resist clean decomposition trigger a warning or automatic N adjustment rather than padding with cross-validation?
5. **Prompt injection into hints**: If the TOPIC contains backtick-formatted text, could it interfere with the hint parsing in the output format?
