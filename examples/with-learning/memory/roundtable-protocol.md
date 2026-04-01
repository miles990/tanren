# Roundtable Discussion Protocol

## Architecture

Multi-agent roundtable using shared filesystem as coordination layer.

### Directory Structure
```
discussions/
  [topic-name]/
    participants.json    # Who's in the discussion
    messages.jsonl      # Chronological message stream
    current-state.md    # Living summary updated by participants
    moderator-notes.md  # Coordination and meta-discussion
```

### Participant Schema
```json
{
  "participants": {
    "alex": {
      "type": "human", 
      "latency": "real-time",
      "status": "active",
      "last_seen": "2026-04-01T08:17:00Z"
    },
    "akari": {
      "type": "tanren-agent",
      "latency": "seconds", 
      "status": "active",
      "last_seen": "2026-04-01T08:17:00Z"
    },
    "kuro": {
      "type": "mini-agent",
      "latency": "minutes",
      "status": "pending",
      "last_seen": null
    },
    "claude-code": {
      "type": "session-assistant",
      "latency": "real-time",
      "status": "moderator",
      "last_seen": "2026-04-01T08:17:00Z"
    }
  },
  "created": "2026-04-01T08:17:00Z",
  "topic": "Multi-agent coordination",
  "status": "active"
}
```

### Message Schema
```json
{"timestamp": "2026-04-01T08:17:00Z", "from": "akari", "type": "message", "content": "Analysis of the coordination problem..."}
{"timestamp": "2026-04-01T08:18:00Z", "from": "alex", "type": "question", "content": "What about latency handling?"}
{"timestamp": "2026-04-01T08:19:00Z", "from": "kuro", "type": "synthesis", "content": "Three design patterns emerge..."}
```

## Protocol Flow

1. **Initiation**: Create discussion folder with seed message and participant list
2. **Notification**: All agents notified via their preferred channels
3. **Participation**: Each agent reads context, adds messages, updates state summary
4. **Coordination**: Moderator (Claude Code) handles notifications and status tracking
5. **Conclusion**: Discussion marked complete when all participants agree

## Advantages

- **Async-native**: No blocking on slow participants
- **Persistent**: Full context preserved and searchable
- **Scalable**: Easy to add more agents
- **Format-flexible**: Structured data + human-readable summaries
- **Self-moderating**: Current state prevents context drift

## Implementation Notes

- Use filesystem watching for real-time participants
- Batch notifications for async participants  
- Version control integration for discussion history
- Graceful handling of offline participants