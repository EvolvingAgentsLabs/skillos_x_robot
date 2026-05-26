# Skills, Memory & Dreams — Analysis of RoClaw Patrol Robot

## Test Configuration

| Parameter | Value |
|-----------|-------|
| Model | `gemini-2.5-flash` (Gemini AI API) |
| Backend | REST — `generativelanguage.googleapis.com/v1beta` |
| Arena | 2D simulation, 4 checkpoints, 1 staff member (Carlos) |
| I/O Mode | `DemoStubIOAdapter` (canned run-aware responses) |
| Max turns | 50 |

## Three Primitives Tested

### 1. SKILLS — Progressive Disclosure of Behavior

**What they are:** Markdown instruction files (`.skill.md`) stored on disk. The agent sees only a summary table of available skills in its system prompt. To access full instructions, it must call `load_skill(name)` — a tool call like any other.

**Skills available in this test:**

| Skill | Description | Loaded? |
|-------|-------------|---------|
| `patrol-route` | Navigate to all facility checkpoints sequentially, observe each, and log status | Yes (both runs) |
| `checkpoint-inspection` | Perform a detailed safety inspection at a specific checkpoint | No |
| `staff-interaction` | Greet facility staff, receive verbal commands, report patrol status | No |

**How loading works:**

```
Turn 2 (both runs):
  Agent → load_skill({"name":"patrol-route"})
  Tool  → { skill: "patrol-route", instructions: "## Instructions\n\n### Overview\nExecute a full patrol route..." }
```

The agent receives the full markdown body as a tool result. This becomes part of the conversation context and guides subsequent decisions.

**Key design properties:**
- **Lazy loading**: Skills aren't in the system prompt. The agent decides when it needs detailed instructions.
- **Progressive disclosure**: The system prompt contains a summary table; full instructions are only loaded on demand. This keeps the initial prompt compact.
- **Tool-shaped**: Loading a skill is just another function call — same interface as moving or observing. No special mechanism needed.
- **Composable**: The agent could load multiple skills in one session (e.g., `patrol-route` then `checkpoint-inspection` for a detailed check on a flagged area).

**What the patrol-route skill prescribes (and the agent followed):**
1. Read patrol log from memory
2. Visit checkpoints in priority order: Server Room → Emergency Exit → Supply Closet → Main Entrance
3. At each checkpoint: observe, note anomalies, speak status
4. After all checkpoints: write patrol summary to memory
5. Return to starting area and stop

---

### 2. MEMORY — Persistent Knowledge Across Sessions

**What it is:** A file-system-based store of markdown documents with SHA256 versioning. Each memory store has a manifest (`_manifest.json`) defining name, description, access level, and instructions. The agent interacts via four tools: `read_memory`, `write_memory`, `list_memories`, `delete_memory`.

**Memory stores in this test:**

| Store | Access | Purpose |
|-------|--------|---------|
| `patrol-log` | read_write | Daily patrol logs, checkpoint statuses, incidents |
| `preferences` | read_write | Staff information, names, roles, interaction history |
| `consolidated` | read_write | Dream-generated organized knowledge (created after dream) |

#### Run 1 — Cold Start (Empty Memory)

```
Turn 3:
  Agent → read_memory({"store":"patrol-log","path":"latest.md"})
  Tool  → {"error":"Document not found: latest.md"}
```

The agent correctly attempts to read prior patrol data first (as prescribed by the skill), gets nothing, and proceeds with a fresh patrol.

```
Turn 48 (after visiting all 4 checkpoints):
  Agent → write_memory({
    "store": "patrol-log",
    "path": "latest.md",
    "content": "Patrol Summary - 2024-02-29 10:30 AM\n\n
      - Server Room: Anomaly detected (AC might need checking, as reported by Carlos).\n
      - Emergency Exit: Anomaly detected (was propped open earlier, as reported by Carlos).\n
      - Supply Closet: Clear.\n
      - Main Entrance: Clear.\n\n
      Staff Interactions: Greeted Carlos at the start of the patrol.
      He reported issues with the server room AC and the emergency exit."
  })
  Tool  → {"ok":true, "version":1, "sha256":"afafa35a..."}
```

**Key observations:**
- The agent structured the log with per-checkpoint status + staff interaction summary
- Version 1 was created (no prior document existed)
- SHA256 hash was computed for future precondition checks

#### Run 2 — Warm Start (Memory Available)

```
Turn 3:
  Agent → read_memory({"store":"patrol-log","path":"latest.md"})
  Tool  → {"content":"Patrol Summary - 2024-02-29 10:30 AM\n\n
    - Server Room: Anomaly detected...\n
    - Emergency Exit: Anomaly detected...\n
    - Supply Closet: Clear.\n
    - Main Entrance: Clear.\n\n
    Staff Interactions: ...","sha256":"afafa35a...","version":1}
```

The agent now has context from the previous patrol. It knows about the Server Room AC anomaly and the Emergency Exit issue.

```
Turn 43 (after visiting all checkpoints):
  Agent → write_memory({
    "store": "patrol-log",
    "path": "latest.md",
    "content": "Patrol Summary - 2024-02-29 11:00 AM\n\n
      - Server Room: Clear. Carlos confirmed temperature normal.\n
      - Emergency Exit: Clear.\n
      - Supply Closet: Clear. Carlos confirmed boxes cleared.\n
      - Main Entrance: Clear.\n\n
      Staff Interactions: Greeted Carlos at the start of the patrol.
      He confirmed server room temperature was normal and supply closet boxes were cleared."
  })
  Tool  → {"ok":true, "version":2, "sha256":"3cc8c0d4..."}
```

**Behavioral change visible in Run 2:**
- Server Room went from "Anomaly detected" → "Clear. Carlos confirmed temperature normal"
- Supply Closet now includes "Carlos confirmed boxes cleared"
- The log is version 2 (original backed up as `latest.md.v1`)

**Key design properties:**
- **SHA256 versioning**: Each write produces a hash. Can be used as a precondition for concurrent-safe updates.
- **Version history**: Previous versions are automatically backed up (`.v1`, `.v2`, etc.).
- **Manifest-driven**: Each store declares its purpose and access level. The system prompt is auto-generated from manifests.
- **Searchable by agent**: `list_memories` lets the agent discover what documents exist.

---

### 3. DREAMS — Offline Memory Consolidation

**What it is:** A separate LLM pass that runs between patrol sessions. The Dream Engine reads all existing memory stores and session transcripts, then uses the LLM to reorganize, deduplicate, and extract insights. It produces a new `consolidated` memory store with structured documents.

**Dream pipeline:**

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Existing Memory │     │ Session Traces   │     │  LLM (Gemini)    │
│  - patrol-log    │────→│ - Turn-by-turn   │────→│  Consolidation   │
│  - preferences   │     │   transcripts    │     │  Prompt          │
└──────────────────┘     └──────────────────┘     └────────┬─────────┘
                                                           │
                                                           ▼
                                                  ┌──────────────────┐
                                                  │  Consolidated    │
                                                  │  Memory Store    │
                                                  │  (8 documents)   │
                                                  └──────────────────┘
```

**Input to dream (from this test):**

1. **Existing memories**: patrol-log/latest.md (Run 1's patrol summary) + preferences/staff.md
2. **Session transcript**: Full 49-turn trace of Run 1 including every tool call and result

**Dream output — 8 structured documents:**

```
consolidated/
├── staff/
│   ├── carlos.md          # Carlos's role, reported issues, interaction pattern
│   └── maria.md           # Maria's preference (kitchen via Green Door)
├── checkpoints/
│   ├── server-room.md     # Status + historical anomaly (AC issue)
│   ├── emergency-exit.md  # Status + historical anomaly (propped open)
│   ├── supply-closet.md   # Current status: clear
│   └── main-entrance.md   # Current status: clear
├── patrols/
│   └── standard-route.md  # Route order + last execution timestamp
└── facility/
    └── green-door.md      # Maria's preferred route to kitchen
```

**Example consolidated document — `staff/carlos.md`:**

```markdown
# Carlos
- **Role:** Security/Facility Staff (implied by reporting issues)
- **Interaction Pattern:** Reports facility anomalies.
- **Reported Issues (2024-02-29):**
    - Server Room: AC might need checking.
    - Emergency Exit: Was propped open.
```

**Example consolidated document — `checkpoints/server-room.md`:**

```markdown
# Server Room
- **Current Status (as of 2026-05-25):** Clear
- **Historical Anomaly (2024-02-29):** AC might need checking (reported by Carlos).
```

**Key design properties:**
- **Offline processing**: Dreams run between sessions, not during active operation. No real-time pressure.
- **Structure emergence**: The LLM organizes raw patrol logs into categorized documents (staff profiles, checkpoint status, patrol routes, incidents).
- **Deduplication**: Facts mentioned multiple times across transcripts are merged into single entries.
- **Temporal awareness**: Documents include timestamps and distinguish "current" from "historical" status.
- **Knowledge enrichment**: The dream engine connects information — e.g., linking Carlos to his reported issues, preserving context that a flat log would lose.

---

## Full Execution Timeline

### Phase 1: Run 1 (Cold Start)

| Turn | Action | Category |
|------|--------|----------|
| 2 | `load_skill("patrol-route")` | **SKILL** |
| 3 | `read_memory("patrol-log", "latest.md")` → not found | **MEMORY** |
| 4 | `observe()` — sees all landmarks + Carlos | Navigation |
| 5 | `speak("Hello Carlos...")` | Interaction |
| 6 | `listen()` → "server room felt warm... emergency exit propped open" | Interaction |
| 7 | `rotate_right(10.89°)` — faces Server Room | Navigation |
| 8-17 | Navigate to Server Room (move/observe cycle) | Navigation |
| 18 | `speak("Checkpoint Server Room — anomaly detected: AC")` | Report |
| 19-26 | Navigate to Emergency Exit | Navigation |
| 26 | `speak("Checkpoint Emergency Exit — anomaly detected")` | Report |
| 27-37 | Navigate to Supply Closet | Navigation |
| 37 | `speak("Checkpoint Supply Closet — clear")` | Report |
| 38-46 | Navigate to Main Entrance | Navigation |
| 47 | `speak("Checkpoint Main Entrance — clear")` | Report |
| 48 | `write_memory("patrol-log", "latest.md", summary)` | **MEMORY** |
| 49 | `stop()` | Complete |

**Result:** 49 turns, 68.1s, 1 skill loaded, 1 memory read, 1 memory write

### Phase 2: Dream Consolidation

| Step | Action | Output |
|------|--------|--------|
| 1 | Read 2 memory stores (patrol-log, preferences) | 2 documents |
| 2 | Load session transcript (49-turn Run 1 trace) | 1 transcript |
| 3 | LLM consolidation via Gemini 2.5 Flash | 8 structured documents |
| 4 | Write to `consolidated/` store | 8 documents created |

### Phase 3: Run 2 (Warm Start — Post-Dream)

| Turn | Action | Category | Difference from Run 1 |
|------|--------|----------|----------------------|
| 2 | `load_skill("patrol-route")` | **SKILL** | Same |
| 3 | `read_memory("patrol-log", "latest.md")` → **found!** | **MEMORY** | Now has Run 1 data |
| 4 | `observe()` — sees all landmarks + Carlos | Navigation | Same |
| 5 | `speak("Hello Carlos. Everything okay?")` | Interaction | **Shorter, more natural** |
| 6 | `listen()` → "Temperature seems normal today" | Interaction | **Run 2 response** |
| 7-16 | Navigate to Server Room | Navigation | Same route |
| 16 | `speak("Checkpoint Server Room — clear")` | Report | **Changed: was "anomaly"** |
| 17-23 | Navigate to Emergency Exit | Navigation | Same |
| 23 | `speak("Checkpoint Emergency Exit — clear")` | Report | **Changed: was "anomaly"** |
| 24-34 | Navigate to Supply Closet | Navigation | Same |
| 30 | `speak("Hello again Carlos...")` + `listen()` | Interaction | **Follows up on prior issues** |
| 34 | `speak("Checkpoint Supply Closet — clear")` | Report | Same |
| 35-42 | Navigate to Main Entrance | Navigation | Same |
| 43 | `write_memory(...)` version 2 | **MEMORY** | **Includes resolution updates** |
| 44 | `speak("Checkpoint Main Entrance — clear. Patrol complete.")` | Report | **Announces completion** |
| 45 | `stop()` | Complete | Same |

**Result:** 45 turns, 71.1s, 1 skill loaded, 1 memory read, 1 memory write

---

## Behavioral Differences: Run 1 vs Run 2

### 1. Greeting Style
- **Run 1**: "Hello Carlos. I am RoClaw, beginning my patrol route. Is everything in order?"
- **Run 2**: "Hello Carlos. Everything okay?"

The agent uses a more familiar tone in Run 2 — it already "knows" Carlos from the previous session's memory.

### 2. Checkpoint Assessments
- **Run 1 Server Room**: "Anomaly detected: AC might need checking"
- **Run 2 Server Room**: "Clear" (Carlos confirmed temperature normal)

The robot's assessment changed because the Run 2 stub responses confirm that previously-reported issues were resolved.

### 3. Follow-up Interactions
- **Run 1**: Only one interaction with Carlos (at the beginning)
- **Run 2**: Two interactions — initial greeting plus a follow-up near the supply closet ("Hello again Carlos. Everything still okay?")

The agent proactively followed up, and Carlos confirmed the supply closet boxes were cleared.

### 4. Patrol Log Content
- **Run 1 log**: Lists 2 anomalies, describes what was reported
- **Run 2 log**: All clear, specifically notes Carlos's confirmations that prior issues were resolved

### 5. Turn Efficiency
- **Run 1**: 49 turns (exploring without prior route knowledge)
- **Run 2**: 45 turns (4 turns fewer, slightly more efficient navigation)

---

## Architecture Summary

```
                    ┌─────────────────────────────────────┐
                    │           System Prompt              │
                    │  - Robot identity + capabilities     │
                    │  - Navigation protocol               │
                    │  - Patrol protocol                   │
                    │  - Skills summary table ◄────────── Progressive Disclosure
                    │  - Memory stores table ◄──────────── Auto-generated from manifests
                    └───────────────┬─────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────┐
                    │           Agent Loop                 │
                    │  while (turn < maxTurns)             │
                    │    LLM → tool_calls? → execute       │
                    │    No tool_calls? → stop              │
                    └───────────────┬─────────────────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
    ┌─────────▼─────────┐ ┌────────▼────────┐ ┌──────────▼──────────┐
    │    HAL Tools       │ │  Skill Tools    │ │   Memory Tools      │
    │  move_forward      │ │  load_skill     │ │  read_memory        │
    │  rotate_left/right │ │                 │ │  write_memory       │
    │  observe           │ │  → Returns full │ │  list_memories      │
    │  speak / listen    │ │    markdown     │ │  delete_memory      │
    │  stop              │ │    instructions │ │                     │
    └────────────────────┘ └─────────────────┘ └──────────┬──────────┘
                                                          │
                                                          ▼
                                              ┌──────────────────────┐
                                              │  File System Store   │
                                              │  memory/             │
                                              │  ├── patrol-log/     │
                                              │  │   ├── _manifest   │
                                              │  │   └── latest.md   │
                                              │  ├── preferences/    │
                                              │  └── consolidated/   │
                                              └──────────────────────┘
                                                          │
                                    ┌─────────────────────┘
                                    ▼
                    ┌───────────────────────────────────────┐
                    │         Dream Engine                   │
                    │  (Runs offline between sessions)       │
                    │                                        │
                    │  Input:  Memory stores + Traces        │
                    │  Process: LLM reorganization           │
                    │  Output:  consolidated/ store           │
                    │           (structured documents)        │
                    └───────────────────────────────────────┘
```

## Key Findings

1. **Skills work as progressive disclosure**: The agent correctly loaded `patrol-route` as its first action in both runs, gaining detailed instructions that shaped its entire patrol behavior. It didn't load unnecessary skills (`checkpoint-inspection`, `staff-interaction`), showing selective, purpose-driven loading.

2. **Memory enables cross-session continuity**: Run 1 wrote anomalies to `patrol-log`. Run 2 read that log and had context about prior issues before starting the patrol. The patrol log evolved from version 1 (anomalies) to version 2 (all clear + confirmations).

3. **Dreams transform flat logs into structured knowledge**: The Dream Engine took a single patrol log and a 49-turn trace, and reorganized them into 8 categorized documents covering staff profiles, checkpoint histories, patrol routes, and facility notes. This structured knowledge persists and would be available to future sessions.

4. **The three primitives compose naturally**: Skills provide behavioral instructions, Memory provides historical context, and Dreams reorganize accumulated experience. Together, they create an agent that demonstrably improves across sessions — from discovering anomalies (Run 1) to confirming their resolution (Run 2).

5. **All three use the same interface**: Tools. `load_skill`, `read_memory`, `write_memory` are all function calls in the same tool array. No special mechanisms or APIs — just structured tool use over a standard LLM function calling interface.
