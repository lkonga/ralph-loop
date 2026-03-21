# Research 2 — `deriveBranchName()` Slug Robustness Analysis

## Question
Is `deriveBranchName()` slug generation robust or fragile? Examine for slug collisions, edge cases, unicode/emoji handling, and truncation ambiguity.

## Findings

### 1. Slug Pipeline — Step-by-Step Transformation

The implementation lives at `src/prd.ts` L21–32. Here is every transformation in order:

```typescript
export function deriveBranchName(title: string): string {
    const PREFIX = 'ralph/';
    const MAX_LENGTH = 50;
    let slug = title
        .toLowerCase()                    // Step 1: case-fold
        .replace(/[^a-z0-9]+/g, '-')      // Step 2: collapse non-alphanumeric runs to single '-'
        .replace(/-{2,}/g, '-')           // Step 3: collapse consecutive hyphens (REDUNDANT — step 2 already collapses runs)
        .replace(/^-|-$/g, '');           // Step 4: strip leading/trailing hyphens
    if (!slug) { slug = 'prd'; }          // Step 5: fallback for empty result
    const maxSlug = MAX_LENGTH - PREFIX.length; // = 44 chars
    slug = slug.slice(0, maxSlug).replace(/-$/g, ''); // Step 6: truncate + strip trailing hyphen
    return PREFIX + slug;
}
```

Key observations:
- Step 3 is dead code: Step 2's `[^a-z0-9]+` already collapses any run of non-alphanumeric characters (including multiple hyphens) into a single `-`.
- Step 4 regex `/-$/g` with global flag is harmless but the anchor makes `/g` irrelevant.
- Step 6 trailing-hyphen strip only catches the single-trailing-hyphen case, which is sufficient since step 2 already collapsed runs.

### 2. Collision Scenarios — Concrete Proof

**Collision class A — Punctuation/symbol variance (HIGH frequency):**

| Title A | Title B | Shared slug |
|---------|---------|-------------|
| `Setup: Phase 1` | `Setup — Phase 1` | `setup-phase-1` |
| `Fix Bug #42` | `Fix Bug (42)` | `fix-bug-42` |
| `v2.0 Release` | `v2_0 Release` | `v2-0-release` |

These are all intentional (standard slug behavior). Not a bug, but worth documenting.

**Collision class B — Unicode/emoji stripping (MEDIUM frequency):**

| Title A | Title B | Shared slug |
|---------|---------|-------------|
| `🚀 Launch` | `🎉 Launch` | `launch` |
| `🚀 Launch` | `Launch` | `launch` |
| `café system` | `cafe system` | differs! `caf-system` vs `cafe-system` |

The regex `[^a-z0-9]` strips ALL non-ASCII including emoji, accented letters, CJK characters, etc. This means:
- Any emoji-only prefix is silently deleted
- Accented characters produce **different** slugs than their unaccented equivalents (e.g., `café` → `caf-` because `é` is stripped but `e` is kept)
- Fully non-ASCII titles (e.g., Japanese/Chinese) collapse entirely to the `'prd'` fallback

**Collision class C — Degenerate fallback (CRITICAL):**

| Title | Slug |
|-------|------|
| `🚀🎉✨` | `ralph/prd` |
| `!!!` | `ralph/prd` |
| `---` | `ralph/prd` |
| `""` (empty string) | `ralph/prd` |

ALL special-character-only and empty titles collapse to the same `ralph/prd` branch. No disambiguation exists.

**Collision class D — Truncation convergence (MEDIUM frequency):**

With a 44-char slug limit, titles that share a long common prefix but differ late will collide:

| Title A | Title B | Truncated slug (44 chars) |
|---------|---------|---------------------------|
| `Build Comprehensive Database Migration Toolkit` | `Build Comprehensive Database Migration Tool Version 1` | `build-comprehensive-database-migration-tool` |

Both titles slug to 44+ chars and share the same first 44 characters after slugification.

### 3. Edge Case Analysis

**Empty title:**
- `parsePrdTitle()` returns `undefined` when no H1 heading exists
- Call site in `featureBranchE2E.test.ts:109` uses `deriveBranchName(parsePrdTitle(...)!)` — the `!` non-null assertion would pass `undefined` to `deriveBranchName`, which then calls `undefined.toLowerCase()` → **runtime crash (TypeError)**
- If called with `""`, the fallback catches it → `"ralph/prd"`

**All-special-character title (e.g., `"***"`, `"🚀🎉"`):**
- Pipeline: → `""` → fallback to `"prd"` → `"ralph/prd"`
- No crash, but indistinguishable from any other invalid title

**Very long title (e.g., 200+ chars):**
- Truncated at 44 chars via `.slice(0, 44)`
- If char 44 falls mid-word, the slug is cut mid-word (e.g., `"framewo"` from `"framework"`)
- If char 44 is a `-`, the trailing-hyphen strip removes it, effectively truncating to 43 chars
- No word-boundary awareness — truncation is purely positional

**Unicode / accented characters:**
- `"naïve"` → `"na-ve"` (ï is stripped, replaced by hyphen between `a` and `v`)
- `"über cool"` → `-ber-cool` → `"ber-cool"` (ü stripped, leading hyphen stripped)
- No unicode normalization (NFC/NFD) is performed
- Characters like ñ, ö, ü, etc. are silently destroyed rather than transliterated

**Numeric-only titles:**
- `"123"` → `"ralph/123"` — works correctly
- `"2026 Sprint 3"` → `"ralph/2026-sprint-3"` — works correctly

### 4. `parsePrdTitle()` Analysis

```typescript
const H1_PATTERN = /^# (.+)$/;

export function parsePrdTitle(prdContent: string): string | undefined {
    for (const line of prdContent.split('\n')) {
        const match = H1_PATTERN.exec(line);
        if (match) { return match[1].trim(); }
    }
    return undefined;
}
```

- Returns `undefined` if no `# ` line exists — caller must guard against this
- Returns first H1 only — multiple H1s silently ignored
- Regex `^# (.+)$` requires at least one character after `# `, so `# ` alone (with trailing space) would not match since `.+` does match a space... actually `(.+)` would match a space. Let me check: `"# "` → match[1] = `" "` → `.trim()` → `""`. So an H1 with only spaces produces an empty string, which then flows into `deriveBranchName("")` → `"ralph/prd"`.

### 5. Test Coverage Assessment

**Dedicated unit tests for `deriveBranchName` / `parsePrdTitle`:** ZERO in `test/prd.test.ts` (both are imported but never directly tested).

**Integration tests in `test/featureBranchE2E.test.ts`:**
- 1 explicit test: `"Ralph Loop V2 — Phase 1 Self-Fix PRD"` → `"ralph/ralph-loop-v2-phase-1-self-fix-prd"` (happy path with em-dash)
- 1 implicit test: `parsePrdTitle('# Commit Test')!` feeding into `deriveBranchName` (simple ASCII)
- 1 implicit test: orchestrator with `"# Snapshot Test"` expecting `"ralph/snapshot-test"` (simple ASCII)

**Untested edge cases (NONE of these have tests):**
- Empty string input
- `parsePrdTitle` returning `undefined` (no H1)
- Unicode / emoji titles
- All-special-character titles
- Titles exceeding 44 slug chars (truncation)
- Trailing hyphen after truncation
- Titles that produce collisions
- Numeric-only titles
- Titles with only whitespace after `# `

## Patterns

1. **Lossy pipeline with silent degradation**: The regex `[^a-z0-9]+` is aggressively ASCII-only. Non-Latin content is silently destroyed rather than transliterated or rejected early. This is a "works for English" pattern that silently fails for internationalized content.

2. **Degenerate fallback collision**: The `'prd'` fallback creates a single collision bucket for all invalid/unusual inputs. There's no uniqueness suffix (hash, timestamp, etc.) to disambiguate.

3. **Positional truncation without word awareness**: The 44-char `.slice()` cuts at arbitrary positions with no attempt at word-boundary alignment. This produces ugly suffixes like `"framewo"` and increases collision risk for titles with long shared prefixes.

4. **Unchecked `undefined` propagation**: The `!` assertion at call sites (`parsePrdTitle(...)!`) converts a recoverable `undefined` into an unrecoverable crash, rather than using the `'prd'` fallback path.

5. **Dead code**: Step 3 (`/-{2,}/g`) is provably redundant given Step 2's `[^a-z0-9]+` already produces single hyphens per non-alphanumeric run.

## Applicability

- **Current usage context**: Ralph-loop is a single-user dev tool where PRD titles are manually authored, English-language, and reasonably descriptive. In this context, the slug function is *adequate* — collisions are unlikely in practice.
- **If used at scale**: The degenerate fallback collision (`ralph/prd` bucket) and lack of unicode handling would become real bugs with multiple concurrent PRDs or international users.
- **Git branch safety**: The output is always valid as a git branch name (lowercase alphanumeric + hyphens), which is a positive.
- **Determinism**: The function IS deterministic (same input → same output), which is essential for session resume and branch detection.

## Open Questions

1. **Should unicode transliteration be added?** (e.g., `café` → `cafe`, `über` → `uber`, `ñ` → `n`) — libraries like `slugify` or `transliterate` handle this. Adds a dependency but prevents data loss.
2. **Should the `'prd'` fallback append a hash suffix** (e.g., `ralph/prd-a3f2`) to prevent degenerate collisions when multiple PRDs have invalid titles?
3. **Should truncation snap to word boundaries?** (e.g., truncate at the last `-` before position 44 rather than mid-word) — trivial to implement: `slug.slice(0, maxSlug).replace(/-[^-]*$/, '')` with a minimum-length guard.
4. **Should the `parsePrdTitle` → `deriveBranchName` call chain handle `undefined` gracefully** instead of relying on `!` assertion? The `'prd'` fallback exists inside `deriveBranchName` but is never reachable from the `undefined` path because the function crashes on `.toLowerCase()` first.
5. **Is step 3 (`/-{2,}/g`) intentionally kept as defensive coding**, or should it be removed as dead code?
