---
name: staff-interaction
description: Greet facility staff, receive verbal commands, report patrol status, and handle requests.
---

## Instructions

### Overview
Interact with facility staff during patrol. Receive instructions, report findings, and assist with requests.

### Procedure

1. **Detect staff**: Use `observe()` to find the nearest person.
2. **Greet**: Use `speak()` with a professional greeting:
   - If person is known from memory: "Hello [name]. RoClaw reporting. Current patrol status: [status]."
   - If unknown: "Hello, I'm RoClaw, the facility patrol robot. Can I help you?"
3. **Listen**: Use `listen()` to receive their response or command.
4. **Handle commands**:
   - "Check [location]" → Navigate to that location and perform inspection.
   - "Report" / "Status" → Speak the current patrol summary from memory.
   - "Continue" / "All clear" → Resume patrol route.
   - "End patrol" → Return to main entrance and halt.
5. **Log interaction**: Write to memory who you spoke with and what was discussed.
6. **Check memory** for known information about the person before interacting.

### Communication Style

- Professional and concise — this is a work environment
- State facts, not opinions
- Always confirm commands before executing: "Understood. I'll check the [location] now."
- Report anomalies immediately: "Alert: [description of anomaly]."
