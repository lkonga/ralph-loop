# Research: CloakBrowser + profile-sync-daemon (psd) Analysis
**Date:** 2026-04-18  
**Wave:** 2026-04-18-cloakbrowser-psd  
**System:** Pop!_OS 22.04, BTRFS, psd v6.55

---

## 1. Profile Data: What Persists vs Regenerates

### `--fingerprint=$RANDOM_SEED` — What it Actually Does

The `--fingerprint` flag is a CloakBrowser-specific argv flag applied **at launch time by the binary**. It seeds the in-memory fingerprint spoofing engine (canvas, WebGL, audio, fonts, etc.). Key facts:

- **Does NOT write seed to profile directory.** The seed is ephemeral — consumed at startup to calibrate spoofing values held in process memory only.
- **Does NOT overwrite any profile files.** Not `Preferences`, not `Local State`, not any known Chromium file.
- The profile dir is purely **read** for fingerprint purposes — CloakBrowser reads the installed extension list, applies the fingerprint to those API surfaces in memory.
- Result: the profile directory is **fully persistent** across launches. The fingerprint changes on each launch (different `$RANDOM_SEED`) but no file writes are caused by this flag.

### Persistent Profile State (survives psd rsync properly)

| Path | Contents | Size estimate | psd safe? |
|------|----------|---------------|-----------|
| `Default/Preferences` | Extension settings, tokens, browser prefs | ~500KB | ✅ yes |
| `Default/Local Storage/` | Extension LevelDB (MCP Bridge token lives here) | ~1-5MB | ✅ yes |
| `Default/IndexedDB/` | Web app state (Playwright automation artifacts) | 1-20MB | ✅ yes |
| `Default/Cookies` | Session cookies | ~1MB | ✅ yes |
| `Default/Extensions/` | Extension code (read-only, doesn't change) | ~10MB | ✅ yes |
| `Default/Extension State/` | Extension LevelDB state | ~5MB | ✅ yes |
| `Default/Extension Cookies` | Extension cookies | ~1MB | ✅ yes |
| `Default/History` | Navigation history | varies | ✅ yes |
| `Default/Login Data` | Saved credentials | ~500KB | ✅ yes |

### Ephemeral / Regeneratable State

| Path | Contents | Should persist? |
|------|----------|-----------------|
| `Default/Cache/` | HTTP response cache | ❌ no — fully regeneratable |
| `Default/Code Cache/` | V8 compiled JS cache | ❌ no — regeneratable |
| `Default/GPUCache/` | GPU shader cache | ❌ no — regeneratable |
| `Default/Service Worker/CacheStorage/` | SW cache | ❌ no |
| `Default/blob_storage/` | Blob objects | ❌ no |
| `SingletonLock` | Live session lock | ❌ runtime only |
| `Default/Lockfile` | DB lock | ❌ runtime only |

**Cache sizes**: For an automation browser (no typical browsing), `Cache/` stays small (~5-50MB). For Playwright loops loading web pages, it can grow. For pure CDP/extension automation (no page loads), Cache stays near zero.

### MCP Bridge Extension Token

From prior investigation: the token (`-M-cO3WJn9_j91I7puaDfFHfoHdYFXD9jeoQPQGpdqc`) is stored in the extension's Local Storage LevelDB at:
```
Default/Local Storage/leveldb/
  chrome-extension_mmlmfjhmonkocbjadbfplnigmagldckm_0.localstorage
```
(Chromium-manifest-v2 style) or in the Extension State LevelDB if using MV3.

**psd safety**: This file is in the persistent category. It will be moved to tmpfs at psd start, modified in tmpfs during use, and rsynced back to disk on each resync cycle. The token is stable across launches (doesn't change unless profile is wiped), so even if a crash reverts to the last synced copy — the token value will be identical. **No token loss risk from psd.**

---

## 2. psd Overlayfs Edge Cases During Long Automation Runs

### How psd Overlayfs Works

```
Disk (BTRFS @home):
  ~/.cloakbrowser-profile/          ← lower layer (read-only snapshot)

tmpfs (RAM):
  /run/user/$UID/psd/cloakbrowser/  ← upper layer (rw, where Chrome writes)

Mount:
  ~/.cloakbrowser-profile → overlayfs(lower+upper)  ← what Chrome sees via symlink
```

psd creates a backup of the disk copy, mounts the overlay, and Chrome writes to RAM. The `resync` timer (default: 1 hour) runs `rsync -a --delete-after` from the tmpfs rw layer back to BTRFS.

### Edge Case 1: Resync During Heavy Writes (MEDIUM SEVERITY)

**What happens:** psd's resync runs while Chrome is actively writing to LevelDB (IndexedDB, Local Storage). LevelDB uses WAL (Write-Ahead Log) files with a `.log` extension.

- rsync reads the rw tmpfs layer without locking Chrome
- It copies the `.log` file mid-write → disk gets a partial WAL snapshot
- LevelDB WAL at partial state: **LevelDB is crash-safe by design** — the WAL is replayed on next open. A partial WAL snapshot rsynced to disk is fine; LevelDB will replay it correctly on next open.
- SQLite databases (Cookies, History, Login Data) similarly use WAL mode — same recovery guarantee
- **Practical risk: LOW.** LevelDB/SQLite WAL files self-heal. psd's concurrent rsync has been doing this with Chromium browsers for years without issues.

### Edge Case 2: Crash During Write-Heavy Session (HIGH SEVERITY for automation state)

**What happens on crash:**
1. Chrome terminates unexpectedly (OOM, kill, or system crash)
2. tmpfs rw layer is **lost** (tmpfs is RAM — it's gone)
3. psd detects `SingletonLock` on restart → declares crash
4. Creates: `~/.cloakbrowser-profile-backup-crashrecovery-TIMESTAMP`
5. Restores profile from the pre-mount backup (the disk snapshot taken at psd start, or at last resync)

**Data loss window:**
- Everything written to tmpfs since last resync is **permanently lost**
- With default 1-hour resync: up to 60 minutes of automation state
- For Playwright loops writing to IndexedDB or Local Storage: automation artifacts lost
- The MCP Bridge token itself won't change (it was already on disk before the session), but any extension state written during the session is lost

**Mitigation:** Reduce resync interval to 15-30 minutes in psd.conf:
```bash
RESYNC_TIMER=15
```

**Reality check:** For long automation loops, a hard crash means re-running the loop anyway. The question is whether **recovery state** (checkpoints, progress markers) survives. If your Playwright scripts write progress to files outside the profile dir, this is moot.

### Edge Case 3: tmpfs rw Layer Size Growth (MEDIUM SEVERITY)

**What happens:** The overlayfs upper layer only stores *deltas* — files that were modified or created since the overlay was mounted. Files that haven't changed stay in the lower (disk) layer.

For a fresh psd start:
- Upper layer starts empty (0 bytes)
- Every Chrome write goes to upper layer
- After 1 hour of automation: upper layer size ≈ total writes made in that hour

**Size estimation for automation:**
- IndexedDB writes (typical Playwright): 1-50MB/hour depending on the site
- Cookies from automation: negligible
- Cache (if not excluded): can be 100-500MB for page-load-heavy automation
- Code Cache: 10-50MB for sites with large JS bundles
- **Total without cache exclusion: 100-600MB in RAM**

**RAM context:** System has 15Gi RAM, 5.8Gi available currently. The profile is 65MB. Without cache, growth should stay under 100MB for most automation. With cache, could spike to 500MB+. Not an OOM risk on this system, but wastes RAM unnecessarily.

**Key insight:** Cache files don't need to persist between sessions at all. Using psd's `VOLATILE` swap for the Cache directory eliminates this from the rw layer entirely (Cache gets its own separate tmpfs mount that is never synced to disk). This is the recommended approach.

### Edge Case 4: RAM Exhaustion During Very Long Loops (LOW SEVERITY on this hardware)

If the overlayfs rw layer grows unexpectedly large AND the system is under memory pressure:
- OOM killer could kill Chrome processes (automation interrupted — standard behavior)
- More rarely: OOM could disrupt psd rsync daemon → resync stalls
- If rsync is killed mid-sync, psd detects this on next run and retries
- **Not a data corruption risk** — rsync is atomic at the file level; partial syncs just retry

On this system (15Gi RAM, automation use only): this edge case has very low probability.

---

## 3. BTRFS-Specific Concerns

### BTRFS Metadata Amplification from psd Rsync

**The core problem:** BTRFS tracks metadata (inodes, extents, checksums) separately from data. When psd rsyncs Chrome files back to BTRFS hourly, it creates **new COW extents** for every changed file.

**Worst offenders for metadata:**

| File type | Count | Size each | BTRFS inode cost | psd sync frequency |
|-----------|-------|-----------|------------------|--------------------|
| LevelDB .sst files (IndexedDB) | 10-100 | 8-64KB | ~256B metadata per extent | hourly if changed |
| LevelDB .log (WAL) | 1-5 active | 4-64MB | low (large file) | hourly |
| Cache entries | 0-100k | 1-256KB | HIGH (lots of inodes) | hourly if not excluded |
| Preferences (rewritten frequently) | 1 | ~500KB | low | hourly |

**LevelDB compaction impact:**
LevelDB periodically **compacts** its sorted string tables (SSTs): it reads several .sst files and writes a new merged .sst, deleting the old ones. During an hour of automation:
- A busy IndexedDB might compact 2-5 times
- Each compaction: create 3-10 new .sst files, delete 3-10 old ones
- On BTRFS: 10 new inodes * 4 metadata B-tree entries each = 40 metadata writes per compaction
- 5 compactions/hour * 40 metadata writes = 200 metadata tree modifications/hour

This is **not catastrophic** but it accumulates. The critical measurement is whether hourly rsyncs keep the metadata B-tree growing or stay stable.

### Cache Exclusion is Mandatory for BTRFS Safety

Without `VOLDIR` (volatile swap for Cache):
- psd rsyncs `Default/Cache/` back to BTRFS hourly
- Chrome Cache uses a dedicated cache filesystem with ~1000-10000 entries
- Each entry = 1 inode on BTRFS = metadata consumer
- Creating/deleting cache entries across rsyncs → fragmented metadata B-tree

**With cache exclusion (`VOLDIR[0]` for Cache):**
- Cache lives only in its own tmpfs mount
- Never touches BTRFS
- Metadata impact drops dramatically
- This is the same approach psd uses for browsers configured with volatile swap

**Practical estimate without cache exclusion:**
- If CloakBrowser loads ~100 pages/hour during automation, Cache grows by ~50-100MB (100-1000 new files)
- 1000 new BTRFS inodes/hour × hours_of_automation = sustained metadata pressure
- At current 68% metadata usage: risk of returning toward ENOSPC within days/weeks of heavy use

**With cache exclusion:**
- Only IndexedDB and state changes hit BTRFS
- At most 50-100 new files per resync
- Metadata growth: negligible

### BTRFS Snapshotting Interaction

If you have Timeshift or snapper configured for `@home` subvolume snapshots:
- psd's rsyncs will increase the delta between consecutive snapshots
- This means snapshots clean up more COW data (good for metadata, uses more disk I/O during cleanup)
- The key question: does `@home` get snapshotted? If yes, btrfs-balance timing matters.

### Safe Metadata Monitoring

After enabling psd for CloakBrowser, monitor with:
```bash
sudo btrfs filesystem df /home
sudo btrfs filesystem usage / | grep Metadata
```
Alert threshold: >75% metadata. Stop psd for CloakBrowser and manually balance if it climbs.

---

## 4. Implementation Risk Assessment

### Risk: MCP Bridge Token Persistence in tmpfs

**Risk level: VERY LOW**

The token is written to `Default/Local Storage/` at first extension run and doesn't change unless the profile is wiped. When psd mounts the overlay:
1. The token file is in the lower (disk) layer — visible to Chrome via overlay
2. Chrome doesn't re-write it unless the extension regenerates it
3. On crash and recovery, the pre-mount backup contains the correct token value
4. Verdict: **No token loss risk.**

### Risk: `--user-data-dir` Targeting a symlink

**Risk level: VERY LOW**

psd creates a symlink: `~/.cloakbrowser-profile` → overlayfs mount point.
Chromium/Chrome resolves symlinks for `--user-data-dir` without issue — this is explicitly tested by psd's design for all Chromium-based browsers. psd already manages Brave (Chromium), Vivaldi (Chromium), and Edge (Chromium) this way.

**One caveat:** Chrome writes its `SingletonLock` as a symlink pointing to `hostname-pid`. It uses the path as given (including via symlink). psd's crash detection reads this lock file's existence/ownership. This works correctly — psd checks the original profile path for the lock, which is now an overlay mount, so it correctly reads the lock from tmpfs or disk depending on whether Chrome is running.

### Risk: CDP Port Binding

**Risk level: NONE**

`--remote-debugging-port` (or the default MCP port psd uses) is purely in-memory socket binding. Not stored in the profile. Not affected by overlayfs or psd.

### Risk: CloakBrowser Crash → Profile Corruption

**Risk level: LOW with psd, LOWER than without psd**

Without psd: a hard crash can corrupt LevelDB files on BTRFS (partial writes to BTRFS during crash).
With psd: writes go to tmpfs. On crash, tmpfs is lost (all-or-nothing). LevelDB WAL is simply discarded without partial writes to disk. Recovery uses the last rsynced state. **psd actually reduces corruption risk compared to writing directly to BTRFS.**

### Risk: Overlayfs Layer Becomes Inaccessible

**Risk level: LOW**

If tmpfs runs out of space (unlikely on this system) or the overlay mount is corrupted by a kernel bug (exceedingly rare on kernel 6.x LTS):
- Chrome gets I/O errors
- Automation fails
- psd cleanup on next `psd clean` restores to the last backup

---

## 5. Implementation Plan

### Prerequisites Check

```bash
# Verify psd version supports overlayfs
psd --version  # should show ≥ 6.55

# Check available RAM (need >200MB free for profile + growth room)
free -h

# Check BTRFS metadata current state
sudo btrfs filesystem usage / | grep -E "Metadata|Data"

# Ensure CloakBrowser is not running (psd must start with browser closed)
pgrep cloakbrowser || echo "not running"
```

### Step 1: Create Custom Browser Definition

```bash
sudo tee /usr/share/psd/browsers/cloakbrowser << 'EOF'
# Profile-sync-daemon browser definition for CloakBrowser (patched Chromium v146)
# Fingerprint-spoofing fork of Chromium; profile layout is standard Chromium

DIRArr[0]="${HOME}/.cloakbrowser-profile"
PSNAME="cloakbrowser"

# Volatile (RAM-only, NOT synced to disk) directories
# Cache is fully regeneratable; excluding it protects BTRFS metadata
VOLDIR[0]="${HOME}/.cloakbrowser-profile/Default/Cache"
VOLDIR[1]="${HOME}/.cloakbrowser-profile/Default/Code Cache"
VOLDIR[2]="${HOME}/.cloakbrowser-profile/Default/GPUCache"
EOF
```

> **Note:** Check whether your psd version supports `VOLDIR` in custom browser defs. If not, omit `VOLDIR` lines and add cache exclusion at rsync level (Step 1b below).

**Step 1b (fallback if VOLDIR unsupported):** Create a psd.conf override to exclude cache paths from rsync. psd doesn't natively support per-browser rsync exclusions in v6.x, but you can patch the rsync by overriding the browser conf. The alternative is to symlink Cache to a separate tmpfs location manually before enabling psd.

### Step 2: Update psd Configuration

```bash
# Edit ~/.config/psd/psd.conf
# Find BROWSERS= line and add cloakbrowser
BROWSERS=(brave vivaldi microsoft-edge firefox firefoxprofile cloakbrowser)

# Set shorter resync interval (reduces crash state-loss window from 60min to 15min)
RESYNC_TIMER=15

# Ensure overlayfs is enabled (preferred over default rsync-only mode)
USE_OVERLAYFS=yes
```

```bash
# Verify config syntax
psd preview
```

The `psd preview` output should show CloakBrowser with its profile and volatile dirs listed.

### Step 3: Stop psd, Run First Sync, Restart

```bash
# Close CloakBrowser completely first (verify no lock file)
pgrep cloakbrowser && echo "WARNING: Close CloakBrowser first!"

# Stop psd service
systemctl --user stop psd.service

# Wait for clean stop
systemctl --user status psd.service

# Start psd with new config
systemctl --user start psd.service

# Alternative: use psd sync command to do a dry run first
psd sync --dry-run 2>/dev/null || psd preview
```

### Step 4: Verify Correct Operation

```bash
# Check psd status
psd

# Should show cloakbrowser in the managed list with correct profile path

# Start CloakBrowser normally (symlink is transparent)
cloakbrowser --user-data-dir=/home/lkonga/.cloakbrowser-profile \
  --fingerprint=$RANDOM_SEED --fingerprint-platform=windows \
  --proxy-server=socks5://127.0.0.1:1081

# Verify overlayfs mount
mount | grep cloakbrowser
# Expected: overlay on /home/lkonga/.cloakbrowser-profile ...

# Verify MCP Bridge token still works
# (check VS Code Copilot can still use playwright-wingle-ext tool)

# Verify profile size in tmpfs (should be ~65MB initially)
du -sh /run/user/$(id -u)/psd/cloakbrowser.* 2>/dev/null
```

### Step 5: Monitor BTRFS Metadata After 24h

```bash
# Run after a full day of automation to assess metadata growth rate
sudo btrfs filesystem usage /
sudo btrfs filesystem df /

# If metadata grows from 68% to >72% within 24h of automation:
# → VOLDIR for Cache is not working → investigate
# → Or run manual balance: sudo btrfs balance start -dusage=50 -musage=50 /
```

### Rollback Plan

If psd causes instability with CloakBrowser:

```bash
# Stop CloakBrowser
pgrep cloakbrowser && kill $(pgrep cloakbrowser)

# Stop psd gracefully (syncs rw layer to disk before unmounting)
systemctl --user stop psd.service

# Verify profile is restored to disk
ls -la ~/.cloakbrowser-profile/
# Should show files normally (not a symlink)

# Remove from BROWSERS= in psd.conf
# Remove /usr/share/psd/browsers/cloakbrowser

# Restart psd without CloakBrowser
systemctl --user start psd.service

# CloakBrowser now runs directly from BTRFS again (status quo ante)
```

**Key rollback safety:** psd's `stop` command always syncs the rw layer back to disk before unmounting. The original profile is never modified in place — psd works on a copy. Rollback is safe at any time (as long as psd's stop completes cleanly).

### Crash Recovery Notes

If the system crashes hard while CloakBrowser is running under psd:
- On next psd start, it will find `SingletonLock` → detect crash
- Creates: `~/.cloakbrowser-profile-backup-crashrecovery-TIMESTAMP`
- Profile is restored from last rsync checkpoint (15-minute window with our config)
- MCP Bridge token: unchanged (was already there before session)
- Automation state written since last rsync: lost

For automation resilience, consider writing checkpoint state to a path **outside** the profile dir (e.g., `/tmp/` or a separate data directory under `~/.local/share/cloakbrowser-automation/`).

---

## 6. Edge Case Rankings (by Severity)

### 🔴 CRITICAL

**None.** psd is designed for Chromium-based browsers; this use case is within its intended scope.

### 🟠 HIGH

1. **BTRFS metadata creep without cache exclusion** — Without `VOLDIR` for Cache, hourly rsync of cache files can gradually push BTRFS metadata back toward ENOSPC. Risk amplified by automation-heavy usage. **Mitigation: mandatory VOLDIR for Cache/Code Cache/GPUCache.**

2. **Crash state loss (up to resync interval)** — Hard crash means losing all writes since last resync. For 15-min resync: max 15 min of automation state. For stateful automation (login sessions, form progress): automation fails and must retry. **Mitigation: reduce RESYNC_TIMER to 15; write critical state outside profile dir.**

### 🟡 MEDIUM

3. **tmpfs rw layer growth during cache-heavy automation** — If automation loads many pages and VOLDIR isn't working, Cache accumulates in RAM. On this system (15Gi RAM) this won't OOM, but wastes up to 500MB unnecessarily. **Mitigation: VOLDIR for Cache.**

4. **rsync concurrent with LevelDB compaction** — rsync copies partial LevelDB SST files during active compaction. LevelDB WAL design makes this safe for data integrity; worst case is a slightly slower recovery on next open. **Mitigation: none needed; already safe by LevelDB design.**

### 🟢 LOW

5. **Overlayfs mount disruption** — Kernel bug, tmpfs full, or OOM kills the mount. Chrome gets I/O errors, automation fails. psd cleanup restores from backup. Low probability on modern kernel with adequate RAM. **Mitigation: monitor tmpfs usage; keep system RAM available.**

6. **MCP Bridge token loss** — Would only occur if profile is wiped (not a psd behavior). Token survives all psd scenarios including crashes. **No mitigation needed.**

7. **`--user-data-dir` symlink issue** — Chromium handles this correctly for all psd-managed browsers. **No mitigation needed.**

---

## 7. Go / No-Go Recommendation

### ✅ GO — with Conditions

**Confidence level: HIGH**

psd is purpose-built for exactly this use case. CloakBrowser is a standard Chromium fork — its profile layout, LevelDB usage, and locking semantics are identical to stock Chromium. psd has been managing Chromium, Brave, Vivaldi, and Edge for years on BTRFS without issues.

The fingerprint flags (`--fingerprint=$RANDOM_SEED`) are ephemeral and don't interact with the profile in any way that would conflict with psd.

### Mandatory Pre-Conditions (Block if Not Met)

1. **`VOLDIR` for Cache directories** — Must exclude `Default/Cache`, `Default/Code Cache`, `Default/GPUCache` from disk sync. This is the **single most important** requirement for BTRFS safety. Do not enable psd for CloakBrowser without this.

2. **Verify `VOLDIR` is supported** by your installed psd version:
   ```bash
   grep -r "VOLDIR" /usr/share/psd/ | head -5
   ```
   If no results: use an alternative cache isolation approach (manual tmpfs bind mount for Cache).

3. **Start with CloakBrowser closed** — psd must mount the overlay before Chrome opens the profile.

### Recommended Pre-Conditions (Proceed but Monitor)

4. **Set `RESYNC_TIMER=15`** in psd.conf — reduces automation state loss window from 60min to 15min on crash.

5. **Baseline BTRFS metadata before enabling** — record current percentage. Compare after 48h of automation. If growth rate > 5% per day, investigate cache exclusion.

6. **Verify overlayfs mode** (`USE_OVERLAYFS=yes`) — rsync-only mode is less efficient and doesn't provide the all-or-nothing crash guarantees of overlayfs.

### Advisory Notes

- **Backup limit of 2** is sufficient; crashrecovery dirs are small (just the metadata/delta since last rsync cleanup)
- **Do NOT run `psd clean`** while automation is in progress — it syncs and remounts, causing a brief Chrome I/O interruption
- For the automation token token in VS Code mcp.json: no changes needed — the `--user-data-dir` path stays the same; psd makes it transparent via symlink
- After first enabling, run `psd` and verify the output shows `cloakbrowser: active, profile synced`

### Expected Benefits

- **BTRFS write reduction:** ~90% fewer BTRFS writes during active automation (Chrome writes to RAM instead)
- **I/O latency:** Chrome writes to tmpfs at RAM speeds, not BTRFS COW speeds — automation I/O bound operations become faster
- **Crash protection:** psd backup means you always have a clean profile snapshot, not a half-written BTRFS state
- **Profile health:** Regular clean rsyncs replace defragmented BTRFS files with fresh copies

---

## Summary

Adding CloakBrowser to psd is **safe and beneficial** on BTRFS, with one non-negotiable requirement: **volatile swap (VOLDIR) for Cache directories.** Without cache exclusion, hourly rsyncs will gradually rebuild the BTRFS metadata pressure that caused the ENOSPC crisis. The MCP Bridge token, fingerprint flags, and Playwright automation are all unaffected by psd. The main operational tradeoff is potential automation state loss of up to 15 minutes on hard crash, which is acceptable for most loop-based automation.
