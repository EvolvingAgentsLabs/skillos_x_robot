---
name: checkpoint-inspection
description: Perform a detailed safety inspection at a specific checkpoint — observe, verify, and log findings.
---

## Instructions

### Overview
Conduct a thorough inspection at a single checkpoint location. Used when a specific area needs detailed checking.

### Procedure

1. **Navigate** to the specified checkpoint using `observe()`, `rotate`, and `move_forward`.
2. **Perform 360-degree scan**:
   a. `observe()` at current heading.
   b. `rotate_right(90)` and `observe()` — repeat 3 more times to cover full circle.
3. **Log findings**: For each observation, note:
   - People present (names if recognized from memory)
   - Door/access point status
   - Equipment present or missing
   - Any unusual objects or conditions
4. **Interact with people**: If someone is present:
   a. `speak()`: "Security check. Everything OK here?"
   b. `listen()` for their response.
   c. Log the interaction.
5. **Report**: Use `speak()` to announce findings aloud.
6. **Write to memory**: Save checkpoint status to patrol-log store.

### Safety Priorities

1. Fire safety equipment present and accessible
2. Emergency exits unobstructed
3. Restricted areas (server room) secured
4. No unauthorized personnel in sensitive areas
