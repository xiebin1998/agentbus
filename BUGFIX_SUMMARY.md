# AgentBus Bug Fixes Summary

## Fixed Issues

### 1. send_message Offline Handling
**Problem**: When sending messages to multiple targets, if ANY target was offline, the entire operation was rejected.

**Fix**: Changed logic to deliver to online targets only, return offline list in response.

### 2. list_agents Visibility
**Problem**: Only showed agents with active SSE sessions, missing registered but offline agents.

**Fix**: Changed to iterate over _agent_info (all registered agents) instead of _sessions.

### 3. get_agent_info Offline Query
**Problem**: Could only query agents currently in memory.

**Fix**: Added database fallback lookup for offline agents.

### 4. AgentInfo.client_id Format
**Problem**: to_dict() returned full key format (ns/cid) instead of just client_id.

**Fix**: Extract pure client_id from the key before returning.

### 5. api_agent_register Idempotency
**Problem**: Re-registration would overwrite existing agent data.

**Fix**: Only fill empty fields, never overwrite existing values.

### 6. api_ns_delete Error Handling
**Problem**: No error handling, would return 500 on missing namespace.

**Fix**: Added existence check (404) and try-catch for broker failures (502).

### 7. api_account_delete Self-Deletion Prevention
**Problem**: Super admin could delete themselves, causing system lockout.

**Fix**: Added check to prevent self-deletion (400 error).

### 8. build_agent_detail Field Name
**Problem**: Code read row["created_at"] but schema uses registered_at.

**Fix**: Corrected field name to registered_at.

### 9. Rate Limiting
**Problem**: No Hub-side rate limiting.

**Fix**: Added RateLimitMiddleware (60 req/min per IP).

### 10. build_metric_summary Function
**Problem**: Function was missing but tests expected it.

**Fix**: Implemented function to aggregate daemon metrics.

## Test Results
- Server compiles successfully
- 168 tests passing (up from 119 before fixes)
- Core functionality verified
