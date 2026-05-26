---
name: patrol-route
description: Navigate to all facility checkpoints sequentially, observe each one, and log status in memory.
---

## Instructions

### Overview
Execute a full patrol route through the facility, visiting each checkpoint in order.

### Procedure

1. **Read patrol log** from memory to check last patrol status and any known issues.
2. **Plan your route**: Visit checkpoints in this priority order:
   - Server Room (critical infrastructure)
   - Emergency Exit (safety compliance)
   - Supply Closet (inventory security)
   - Main Entrance (perimeter check)
3. **At each checkpoint**:
   a. Use `observe()` to scan the area.
   b. Note any people, open doors, or anomalies.
   c. If a person is nearby, greet them and ask if everything is OK.
   d. Use `speak()` to announce: "Checkpoint [name] — status [clear/anomaly detected]."
4. **After completing all checkpoints**, write a patrol summary to memory with:
   - Timestamp of patrol
   - Status of each checkpoint (clear / anomaly / person present)
   - Any incidents or observations
5. **Return to starting position** (main entrance area) and announce patrol complete.

### Navigation

- Use `observe()` to find each checkpoint by its landmark label.
- Align heading: positive bearing → `rotate_left`, negative → `rotate_right`.
- Move in 30-50cm steps, re-observe after each move.
- Stop within 0.3m of each checkpoint.

### Anomaly Detection

Flag as anomaly if:
- Unexpected person near server room or supply closet
- Fire extinguisher missing from expected location
- Any landmark not visible from expected distance
