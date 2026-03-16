# Research-3: Academic Sources Validating PRD→Tasks→Per-Task Verify Patterns

**Wave**: 2026-03-16-ralph-deep-verification
**Question**: Detail the academic sources that validate PRD→tasks→per-task verify patterns: Parsel, CodeChain, MetaGPT. Verification mechanisms, decomposition strategies, completion criteria, and why "auto-classification of verification needs" is a research gap.
**Date**: 2026-03-16
**Method**: Local research synthesis from existing wave reports (research-5, research-7, research-4), AI_AGENT_ORCHESTRATION_COMPARISON.md, expert review rankings, and PRD analysis. Cross-referenced with known publication records.

---

## 1. Parsel (Zelikman et al.)

### Paper Details
- **Title**: "Parsel: Algorithmic Reasoning with Language Models by Composing Decompositions"
- **Authors**: Eric Zelikman, Qian Huang, Gabriel Poesia, Noah D. Goodman, Nick Haber
- **Venue**: ICML 2023 (International Conference on Machine Learning)
- **Affiliation**: Stanford University
- **ArXiv**: 2212.10561

### Decomposition Mechanism
Parsel takes a **hierarchical natural-language specification** and decomposes it into a **DAG (Directed Acyclic Graph) of functions** with associated test cases. The specification is written in a custom format where each function is described in natural language with:
1. A **function name** and **description** (the "what")
2. **Dependencies** on other functions in the DAG (the "structure")
3. **Test cases** expressed as input-output assertions (the "verification")

The decomposition is **user-authored but LLM-assembled**: the user writes the hierarchical spec, and the LLM implements each node independently. Functions are resolved bottom-up — leaf nodes (no dependencies) first, then parent nodes that compose child implementations.

### Verification Mechanism
- **Per-component verification**: Each function in the DAG is tested independently against its declared test cases before being composed with other functions.
- **Compositional verification**: After individual functions pass, the complete DAG is executed end-to-end to verify that the composition works.
- **Constraint propagation**: If a function's tests fail, only that node and its dependents are re-generated — the rest of the DAG is preserved. This is a form of **targeted retry** rather than full regeneration.

### Completion Criteria
- **Per-function**: All declared test assertions pass.
- **Per-DAG**: The root-level function produces correct output on provided test cases.
- **No iteration cap documented**: Parsel retries individual nodes until tests pass or a sampling budget is exhausted.

### Relevance to ralph-loop
Parsel's pattern maps directly to ralph-loop's architecture:
| Parsel Concept | Ralph-loop Equivalent |
|---|---|
| Hierarchical natural-language specification | PRD.md with markdown checkboxes |
| DAG of functions | Ordered task list (currently sequential, DAG planned) |
| Per-function test cases | Per-task verification (`VerifierConfig[]`) |
| Bottom-up resolution | Dependency-ordered task execution |
| Compositional verification | End-of-loop integration check |
| Targeted retry on failure | `shouldRetry()` + nudge system |

**Key difference**: Parsel's specifications encode test cases *inline with the spec*. Ralph-loop's PRD tasks contain natural-language descriptions but verification is configured *externally* via `verificationTemplates`. Parsel doesn't face the auto-classification problem because verification is **declared at spec-writing time**.

---

## 2. CodeChain (Le et al.)

### Paper Details
- **Title**: "CodeChain: Towards Modular Code Generation Through Chain of Self-Revisions with Representative Sub-modules"
- **Authors**: Hung Le, Hailin Chen, Amrita Saha, Akash Gokul, Doyen Sahoo, Shafiq Joty
- **Venue**: ICLR 2024 (International Conference on Learning Representations)
- **Affiliation**: Salesforce Research
- **ArXiv**: 2310.08992

### Decomposition Mechanism
CodeChain decomposes coding problems through **modularized sub-functions** using a two-phase approach:
1. **Chain of Self-Revisions**: The LLM generates an initial solution, then iteratively revises it. Each revision is guided by extracting reusable **sub-modules** (helper functions) from previous generations.
2. **Representative Sub-module Mining**: From a pool of generated solutions, CodeChain identifies "representative" sub-modules that appear across multiple solutions — these are likely to be correct and reusable.
3. **Modular Composition**: Selected sub-modules are composed into a final solution, with the LLM filling in the glue logic.

The decomposition is **emergent** rather than user-specified: the LLM discovers module boundaries through repeated generation and analysis. This contrasts with Parsel's user-authored decomposition.

### Verification Mechanism
- **Per-module verification**: Each extracted sub-module is tested independently via unit tests (either provided by the benchmark or generated).
- **Per-composition verification**: After modules are composed, the full solution is tested against integration/acceptance tests.
- **Iterative self-revision loop**: If composition tests fail, the revision cycle produces new candidate modules. The "chain" in CodeChain refers to this iterative revision → extract → compose → test cycle.
- **Cross-solution representative mining**: Verification is implicit in the mining step — sub-modules that appear in multiple independently-generated solutions are more likely correct (a form of **majority-vote verification**).

### Completion Criteria
- **Benchmark tests pass**: On competitive programming benchmarks (APPS, CodeContests), the criterion is passing all provided test cases.
- **Max revision rounds**: A fixed cap on the number of self-revision iterations (typically 3-5 rounds).
- **Dual gate**: Tests pass AND revision rounds exhausted → stop.

### Relevance to ralph-loop
| CodeChain Concept | Ralph-loop Equivalent |
|---|---|
| Self-revision cycle | Nudge + retry system (re-send task on timeout/failure) |
| Per-module unit tests | Per-task verifiers (`vitest`, `tsc`) |
| Per-composition integration tests | Cross-task verification (end-of-loop) |
| Representative sub-module mining | N/A — ralph-loop doesn't mine across multiple attempts |
| Iterative improvement | `StagnationDetector` + `StruggleDetector` for detecting when iteration isn't productive |

**Key difference**: CodeChain's verification applies the *same type* (test execution) at both levels — module and composition. It doesn't classify different verification types for different modules. All modules get unit tests; all compositions get integration tests. The verification type is fixed, not task-dependent.

---

## 3. MetaGPT (Hong et al.)

### Paper Details
- **Title**: "MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework"
- **Authors**: Sirui Hong, Xiawu Zheng, Jonathan Chen, Yuheng Cheng, Jinlin Wang, Ceyao Zhang, Zili Wang, Steven Ka Shing Yau, Zijuan Lin, Liyang Zhou, Chenyu Ran, Lingfeng Xiao, Chenglin Wu
- **Venue**: NeurIPS 2023 (Oral, later published in ICLR 2024 as extended version)
- **Affiliation**: DeepWisdom, multiple universities
- **ArXiv**: 2308.00352

### Decomposition Mechanism
MetaGPT is the closest academic system to a **PRD-driven autonomous loop**. It assigns **Standard Operating Procedures (SOPs)** to different agent roles in a software development pipeline:

1. **Product Manager Agent**: Takes user requirements → generates a structured **PRD** (Product Requirements Document) with user stories, competitive analysis, and acceptance criteria.
2. **Architect Agent**: Takes the PRD → produces a **system design document** with data structures, API definitions, class diagrams (in Mermaid), and file structure.
3. **Engineer Agent**: Takes the design → implements code file by file.
4. **QA Agent**: Takes the implementation → generates test cases and runs them.

Each phase transition is **specification-driven**: the output document of one phase becomes the input specification of the next. The pipeline is sequential: PM → Architect → Engineer → QA.

### Verification Mechanism
- **Document-level gates**: Each agent role produces a structured document. The next agent validates it implicitly by consuming it — if the Architect can't produce a valid design from a bad PRD, the pipeline degrades (though MetaGPT doesn't have formal rejection/retry at this level).
- **Code Review Agent**: An optional reviewer role inspects generated code for quality.
- **QA Agent with test execution**: The QA agent writes pytest tests and executes them. Test results gate the completion of the engineering phase.
- **Executable feedback**: When tests fail, error messages are fed back to the Engineer agent for iterative fixing (similar to Reflexion's verbal feedback pattern).
- **Human-as-final-gate**: MetaGPT's pipeline terminates with generated artifacts; human review is assumed but not enforced.

### Completion Criteria
- **Per-phase**: Each agent completes when it produces its deliverable document/artifact.
- **Per-pipeline**: The QA agent's test suite passes, or the max iteration budget is consumed.
- **No dynamic redecomposition**: If the QA tests fail, the Engineer retries the implementation — but the decomposition (PRD structure, design) is NOT revised. This is a key limitation.

### Relevance to ralph-loop
| MetaGPT Concept | Ralph-loop Equivalent |
|---|---|
| SOP-driven agent pipeline | PRD → task list → sequential execution |
| Product Manager generates PRD | User authors PRD.md (ralph-loop is *user-authored*, not LLM-generated) |
| Architect → Engineer handoff | Task prompt with full context (PRD + progress.txt) |
| QA → test execution | `VerifierRegistry` with `vitest`, `tsc`, `commandExitCode` |
| Document-as-specification | PRD.md checkbox as task specification AND completion tracker |
| LLM for all phase transitions | **Key difference**: ralph-loop uses deterministic verification, not LLM |

**Key differences**:
1. MetaGPT uses LLMs for *all* phase transitions (including verification decisions). Ralph-loop uses deterministic machine verification — no LLM in the verification loop.
2. MetaGPT's PRD is *LLM-generated* from brief user input. Ralph-loop's PRD is *user-authored* with markdown checkboxes — simpler, more controllable, and version-trackable.
3. MetaGPT doesn't have a circuit breaker, nudge system, or stagnation detection — it runs until completion or budget exhaustion.

---

## 4. Why "Auto-Classification of Verification Needs" is a Research Gap

### The Problem Statement

Given a task description (e.g., "Add OAuth2 authentication to the API"), automatically determine:
- **What type** of verification is needed (unit tests? integration tests? type checking? visual inspection? manual review?)
- **What tools** to use for verification (vitest? pytest? tsc? curl? browser?)
- **What acceptance criteria** to apply (exit code 0? specific output? file existence? pattern matching?)

### What Existing Papers Do (and Don't)

| Paper | What it classifies | What it DOESN'T classify |
|---|---|---|
| **Parsel** | User declares test cases per function in the spec | Doesn't auto-determine test type from description — tests are manually authored inline |
| **CodeChain** | Applies uniform test execution to all modules | Doesn't distinguish module types — same verification for all |
| **MetaGPT** | QA agent generates tests based on implementation | Doesn't classify task TYPE before deciding verification strategy — all tasks get the same pytest treatment |
| **AgentCoder** | Test Designer agent generates tests from requirements | Closest to auto-classification — dynamically generates test *content* but not test *type* |
| **SWE-bench** | Pre-existing test suites determine verification | No classification needed — tests are given |
| **Reflexion** | Binary pass/fail on given tests | No classification of verification type |

### Why This is a Gap

1. **Existing systems assume homogeneous verification**: Every paper surveyed applies the *same type* of verification (unit test execution) to all tasks/modules. Real-world software tasks require heterogeneous verification:
   - "Add a button" → visual inspection + accessibility check
   - "Fix the SQL injection" → security scan + unit test
   - "Refactor the service layer" → type check + integration test
   - "Update the README" → no automated verification (human review only)

2. **No paper models verification type as a decision variable**: The verification strategy is always fixed at design time (hardcoded test execution). No system treats "what kind of verification" as something to be decided *at runtime* based on task characteristics.

3. **The classification taxonomy is undefined**: Ralph-loop's 6 verification types (`diagnostics`, `fileExists`, `fileContains`, `vscodeTask`, `globExists`, `userConfirm`) represent a first attempt at a taxonomy, but no academic paper has proposed or evaluated such a classification scheme.

4. **Selection logic is unstudied**: Even if a taxonomy existed, the mapping function `taskDescription → Set<VerificationType>` has not been studied. Should it be rule-based (keyword matching)? ML-based (trained classifier)? LLM-based (prompt the model to choose)? Each approach has different reliability and cost tradeoffs.

5. **Verification cost awareness is absent**: Different verification types have vastly different costs (checking a checkbox: ~0ms, running a test suite: ~30s, manual review: unbounded). No paper models verification cost as part of the selection decision. Ralph-loop's `computeConfidenceScore` with weighted results is a unique first step.

### Adjacent Work That Partially Touches This

- **AgentCoder** (Huang et al., 2024): Its Test Designer agent generates test *code* from requirements, which is a form of "what should we test?" But it always generates unit tests — it doesn't choose between unit tests, integration tests, linting, or manual review.
- **Parsel** (Zelikman et al., ICML 2023): Its specification-to-test pipeline decides *what to test* per function, but the user writes the test cases — the system doesn't auto-generate the verification strategy.
- **LATS** (Zhou et al., NeurIPS 2023): Its quality scoring could inform verification intensity (more iterations = stricter checks), but doesn't classify verification type.

### Opportunity for Ralph-loop

Ralph-loop is uniquely positioned to address this gap because:
1. It already has a **verification taxonomy** (6+ types in `VerifierRegistry`)
2. It already has a **template matching system** (`verificationTemplates` with keyword matching)
3. It already has a **cost-aware scoring system** (`computeConfidenceScore` with weights)
4. The gap between keyword matching and true auto-classification could be bridged with a trained classifier or LLM-based selector

The research contribution would be: **formalizing the verification type selection problem, proposing a taxonomy, evaluating selection strategies (rule-based vs. ML vs. LLM), and measuring impact on loop completion rates.**

---

## 5. Summary Comparison Table

| Dimension | Parsel | CodeChain | MetaGPT |
|---|---|---|---|
| **Paper** | "Parsel: Algorithmic Reasoning..." | "CodeChain: Towards Modular Code Generation..." | "MetaGPT: Meta Programming..." |
| **Venue/Year** | ICML 2023 | ICLR 2024 | NeurIPS 2023 |
| **Key Authors** | Zelikman, Huang, Goodman (Stanford) | Le, Sahoo, Joty (Salesforce) | Hong et al. (DeepWisdom) |
| **Decomposition** | User-authored hierarchical spec → DAG of functions | Emergent modularization via self-revision mining | SOP pipeline: PM → Architect → Engineer → QA |
| **Verification Gate** | Per-function test assertions + compositional DAG test | Per-module unit tests + per-composition integration tests | QA agent generates and runs pytest suite |
| **Completion Criteria** | All DAG nodes pass tests | Benchmark tests pass OR max revisions | QA tests pass OR budget exhausted |
| **Who decides verification type?** | User (inline test cases) | Fixed (always unit/integration tests) | Fixed (always pytest) |
| **Retry mechanism** | Re-generate failing node only | Full self-revision cycle | Engineer retries with error feedback |
| **PRD involvement** | None (uses custom spec format) | None (uses problem statement) | Yes — PM agent generates PRD |
| **Deterministic verification?** | Yes (test assertions) | Yes (test execution) | Partially (QA agent is LLM-based) |
| **Auto-classification of verification type?** | No | No | No |

---

## 6. Key Citations

| # | Full Citation | Key Contribution |
|---|---|---|
| 1 | Zelikman, E., Huang, Q., Poesia, G., Goodman, N.D., & Haber, N. (2023). "Parsel: Algorithmic Reasoning with Language Models by Composing Decompositions." *ICML 2023*. arXiv:2212.10561 | Spec → DAG → per-unit test → composition test |
| 2 | Le, H., Chen, H., Saha, A., Gokul, A., Sahoo, D., & Joty, S. (2024). "CodeChain: Towards Modular Code Generation Through Chain of Self-Revisions with Representative Sub-modules." *ICLR 2024*. arXiv:2310.08992 | Iterative self-revision with per-module verification |
| 3 | Hong, S., Zheng, X., Chen, J., Cheng, Y., et al. (2023). "MetaGPT: Meta Programming for A Multi-Agent Collaborative Framework." *NeurIPS 2023*. arXiv:2308.00352 | SOP-driven PRD pipeline with QA verification agent |
| 4 | Huang, D., Bu, Q., Zhang, J., Luck, M., & Cui, H. (2024). "AgentCoder: Multi-Agent-based Code Generation with Iterative Testing and Optimisation." arXiv:2312.13010 | Dynamic test generation from requirements (closest to auto-classification) |
| 5 | Shinn, N., Cassano, F., Gopinath, A., Narasimhan, K., & Yao, S. (2023). "Reflexion: Language Agents with Verbal Reinforcement Learning." *NeurIPS 2023*. arXiv:2303.11366 | Verbal feedback loops for iterative correction |

---

## 7. Open Questions

1. **Could Parsel's inline test specification be adopted by ralph-loop?** E.g., `- [ ] Add OAuth2 login [test: "POST /auth returns 200"]` — encoding verification in the task description itself.
2. **Would CodeChain's representative sub-module mining improve ralph-loop's retry quality?** If a task fails multiple times, mining successful patterns from previous tasks could guide the retry.
3. **Is MetaGPT's PRD generation worth adding as an optional phase?** Ralph-loop currently requires user-authored PRDs. An optional "PRD from brief" generator could lower the barrier to entry.
4. **What training data would a verification-type classifier need?** Task descriptions paired with ground-truth verification types — this dataset doesn't exist yet.
5. **Is the verification taxonomy complete?** Ralph-loop's 6 types + PRD checkbox + LLM-as-judge covers most scenarios, but categories like "performance regression test," "API contract validation," or "accessibility audit" may be missing.
