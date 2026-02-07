# RFC: OpenClaw Rescue Agent

**Status:** Draft  
**Author:** OpenClaw Team  
**Created:** 2026-02-07  
**Last Updated:** 2026-02-07

## Abstract

The OpenClaw Rescue Agent is an independent, AI-powered debugging and recovery system designed to monitor, diagnose, and repair the main OpenClaw gateway when it fails or becomes unresponsive. Unlike simple restart mechanisms, the Rescue Agent uses AI to understand problems, autonomously fix configuration issues, analyze logs, and take corrective actions with appropriate guardrails.

## Motivation

The main OpenClaw gateway is a complex system with many failure modes:

- Configuration errors from manual edits
- Process crashes from resource exhaustion
- Plugin failures cascading to the main process
- Network connectivity issues
- Database corruption or migration failures

When OpenClaw fails, users lose access to their AI assistant and all connected services. Currently, recovery requires manual SSH access, log analysis, and troubleshooting. This is frustrating and time-consuming, especially for non-technical users.

**The Rescue Agent solves this by being:**

1. **Always available** — runs independently of the main gateway
2. **Intelligent** — uses AI to diagnose and fix problems, not just restart
3. **Accessible** — multiple fallback access methods when primary channels fail
4. **Autonomous** — proactively monitors health and auto-repairs common issues

## Goals

- ✅ Provide intelligent debugging and repair capabilities via AI
- ✅ Survive main gateway failures (separate process, minimal dependencies)
- ✅ Offer multiple access methods for emergency recovery
- ✅ Auto-detect and fix common configuration problems
- ✅ Maintain detailed audit logs of all rescue operations
- ✅ Prevent the rescue agent itself from becoming a security vulnerability

## Non-Goals

- ❌ Replace the main OpenClaw gateway
- ❌ Provide full feature parity with the main agent
- ❌ Support all OpenClaw plugins and extensions
- ❌ Run on a different machine (same host only)

---

## Architecture

### Process Separation

The Rescue Agent runs as a completely separate process from the main gateway:

```
┌─────────────────────────────────────┐
│     Main OpenClaw Gateway           │
│  - Full AI capabilities             │
│  - All plugins & channels           │
│  - Primary user interface           │
└─────────────────────────────────────┘
              ↕ monitors
┌─────────────────────────────────────┐
│     Rescue Agent Process            │
│  - Lightweight AI model             │
│  - Limited dependencies             │
│  - Read/write config access         │
│  - Multiple access methods          │
└─────────────────────────────────────┘
```

**Key characteristics:**

- Independent executable: `openclaw rescue start`
- Separate PID, memory space, event loop
- Does NOT import or depend on main gateway code
- Shares only: config files, log files, and the database (read-only for db)

### AI Model Selection

**Recommended model: `anthropic/claude-opus-4-6`**

**Rationale:**

1. **Fast response** — Rescue scenarios require quick diagnosis (Haiku optimized for speed)
2. **Cost-effective** — Runs continuously for monitoring, needs to be economical
3. **Sufficient capability** — Can read logs, parse JSON configs, write fixes
4. **Reliable availability** — Anthropic has high uptime, good fallback story
5. **Small context** — Rescue operations are typically focused tasks

**Fallback cascade:**

1. Primary: `anthropic/claude-opus-4-6`
2. Fallback 1: `openai/claude-sonnet-4-5` (if Anthropic is down)
3. Fallback 2: `google/claude-opus-4-5` (if both above fail)
4. Emergency: Deterministic rules (no AI) for critical operations

### Configuration

**File: `~/.openclaw/rescue.json`**

```json
{
  "version": "1.0",
  "enabled": true,
  "
  "ai": {
    "primaryModel": "anthropic/claude-opus-4-6",
    "fallbackModels": [
      "openai/claude-sonnet-4-5",
      "google/claude-opus-4-5"
    ],
    "maxTokensPerRequest": 4096,
    "temperature": 0.1
  },

  "monitoring": {
    "enabled": true,
    "healthCheckIntervalSeconds": 30,
    "unhealthyThresholdChecks": 3,
    "autoRestartEnabled": true,
    "autoFixConfigEnabled": true,
    "alertOnFailure": true
  },

  "access": {
    "telegram": {
      "enabled": true,
      "commandPrefix": "/rescue",
      "allowedUserIds": []
    },
    "email": {
      "enabled": false,
      "allowedSenders": [],
      "subjectPrefix": "[RESCUE]",
      "checkIntervalSeconds": 60
    },
    "ssh": {
      "enabled": true,
      "command": "openclaw rescue shell"
    },
    "unix_socket": {
      "enabled": true,
      "path": "/tmp/openclaw-rescue.sock",
      "permissions": "0600"
    },
    "web": {
      "enabled": false,
      "port": 7878,
      "bindAddress": "127.0.0.1",
      "requireAuth": true,
      "tailscaleOnly": true
    },
    "mdns": {
      "enabled": true,
      "serviceName": "_openclaw-rescue._tcp"
    }
  },

  "capabilities": {
    "allowConfigEdit": true,
    "allowProcessControl": true,
    "allowCommandExecution": true,
    "allowUpdates": false,
    "commandWhitelist": [
      "systemctl",
      "launchctl",
      "pm2",
      "git",
      "npm",
      "node"
    ],
    "dangerousCommandsRequireConfirmation": true
  },

  "security": {
    "auditLog": "~/.openclaw/logs/rescue-audit.log",
    "requireAuthForAllAccess": true,
    "allowRootCommands": false,
    "maxConcurrentSessions": 3,
    "sessionTimeoutMinutes": 30,
    "rateLimitPerMinute": 20
  },

  "alerting": {
    "channels": ["telegram", "email"],
    "alertOnMainGatewayDown": true,
    "alertOnAutoRepair": true,
    "alertOnAuthFailure": true,
    "quietHoursStart": "23:00",
    "quietHoursEnd": "08:00"
  }
}
```

**Smart Defaults Philosophy:**

- Enable core monitoring and auto-restart by default
- Require explicit opt-in for destructive capabilities
- Telegram access enabled if main OpenClaw has Telegram configured
- Conservative rate limits to prevent abuse
- Audit logging always enabled (cannot be disabled)

### Main Gateway Integration

The main OpenClaw gateway should:

1. **Warn on rescue config modification:**

   ```javascript
   if (fs.existsSync("~/.openclaw/rescue.json")) {
     const rescueConfig = readJSON("~/.openclaw/rescue.json");
     const configHash = hashConfig(rescueConfig);

     if (configHash !== lastKnownHash) {
       console.warn("⚠️  WARNING: Rescue Agent config has been modified");
       console.warn("   Changes to rescue.json may affect emergency recovery");
       console.warn("   Review changes: openclaw rescue config diff");
     }
   }
   ```

2. **Detect if rescue agent is running:**

   ```javascript
   const rescueRunning = await checkProcess("openclaw rescue");
   if (!rescueRunning) {
     console.warn("⚠️  Rescue Agent is not running");
     console.warn("   Start it with: openclaw rescue start");
   }
   ```

3. **Expose health status for monitoring:**
   - HTTP endpoint: `GET /health` returns JSON health status
   - Unix socket: Write health info to `~/.openclaw/health.json` every 30s
   - Process signals: Respond to `SIGUSR1` with status dump

---

## Access Methods

The Rescue Agent must be accessible even when the main gateway is completely down. Each access method has different trade-offs:

### 1. Telegram (`/rescue` prefix)

**Implementation:** Shares the same bot token, but routes `/rescue*` commands to the rescue agent process.

```
User: /rescue status
Bot:  🔧 Rescue Agent v1.0
      Main gateway: ❌ DOWN (not responding to health checks)
      Last successful check: 2 minutes ago
      Auto-restart: ⏳ Attempting restart #2/3

User: /rescue logs
Bot:  📋 Last 50 lines from gateway.log:
      [Shows timestamped log excerpt]

User: /rescue fix config
Bot:  🔍 Analyzing config...
      ❌ Found error in ~/.openclaw/config.json line 42:
         "telegram_token" has trailing comma
      ✅ Fixed: Removed trailing comma
      ✅ Validated: Config now parses correctly
      Restart gateway? (yes/no)
```

**Advantages:**

- Already familiar to users
- Works from anywhere
- Built-in auth via Telegram user ID

**Disadvantages:**

- Requires Telegram to be working
- Requires internet connectivity

**Implementation details:**

- Both main and rescue processes register handlers for the same bot token
- Main process ignores `/rescue*` commands
- Rescue process ONLY responds to `/rescue*` commands
- Use webhook mode with path routing: `/webhook/main` and `/webhook/rescue`

### 2. Email-based Access

**Implementation:** Dedicated email address monitored by rescue agent (e.g., `rescue@yourdomain.com` or `your-email+rescue@gmail.com`).

```
To: your-email+rescue@gmail.com
Subject: [RESCUE] status
Body: (optional)

--- Auto-reply ---
From: OpenClaw Rescue Agent
Subject: Re: [RESCUE] status

🔧 Rescue Agent Status Report

Main Gateway: ❌ DOWN
Last seen: 5 minutes ago
Restart attempts: 3/3 (all failed)

Last error from logs:
  Error: EADDRINUSE: address already in use :::3000

Suggested action: Kill orphaned process on port 3000
Run this command: /rescue exec "lsof -ti:3000 | xargs kill -9"
```

**Advantages:**

- Works when Telegram is down
- Accessible from any email client
- Asynchronous (fire and forget)

**Disadvantages:**

- Slower (1-2 min delay for polling)
- Requires email configuration
- Spam risk

**Implementation details:**

- IMAP poll every 60 seconds (configurable)
- Supports Gmail, Outlook, custom IMAP
- Validates sender address against whitelist
- Sends reply via SMTP
- Subject line parsing for commands: `[RESCUE] <command>`

### 3. SSH Command Interface

**Implementation:** Interactive shell accessible via SSH.

```bash
$ ssh user@yourserver
$ openclaw rescue shell

OpenClaw Rescue Agent v1.0
Type 'help' for available commands, 'exit' to quit.

rescue> status
Main gateway: DOWN
Uptime: 0s (crashed)
Last restart: 2 minutes ago (failed)

rescue> logs --tail 20
[Shows last 20 log lines]

rescue> diagnose
🔍 Running diagnostics...
✅ Node.js version: v20.11.0 (compatible)
✅ Disk space: 45GB free
❌ Port 3000: Already in use by PID 12847
❌ Config validation: Parse error at line 42

rescue> fix port-conflict
🔧 Killing process 12847 (node)...
✅ Port 3000 is now free
✅ Restarting gateway...
✅ Gateway is now UP

rescue> exit
```

**Advantages:**

- Works when network is partially down
- Full interactive control
- Familiar for technical users

**Disadvantages:**

- Requires SSH access to server
- Terminal-only (no GUI)

**Implementation details:**

- REPL-style interface using Node.js `readline`
- Command autocomplete and history
- Syntax highlighting for JSON output
- Runs in same security context as SSH user

### 4. Unix Socket API

**Implementation:** Local IPC socket for programmatic access.

```bash
# Using netcat
$ echo '{"command": "status"}' | nc -U /tmp/openclaw-rescue.sock

{"status":"running","mainGateway":"down","uptime":0}

# Using curl (with socat)
$ curl --unix-socket /tmp/openclaw-rescue.sock http://localhost/status

{
  "status": "running",
  "mainGateway": "down",
  "lastCheck": "2026-02-07T11:05:30Z",
  "autoRestartAttempts": 3
}
```

**Advantages:**

- Fast local communication
- No network required
- Easy integration with scripts

**Disadvantages:**

- Local access only
- Requires socket file permissions

**Implementation details:**

- JSON-RPC 2.0 protocol over Unix socket
- Socket file at `/tmp/openclaw-rescue.sock` (configurable)
- Permissions: `0600` (owner only) by default
- Supports streaming responses for logs

### 5. Tailscale Web UI

**Implementation:** Simple web interface accessible via Tailscale IP (or localhost).

```
http://100.64.0.1:7878/rescue

┌─────────────────────────────────────┐
│   🔧 OpenClaw Rescue Agent          │
├─────────────────────────────────────┤
│ Main Gateway Status: 🔴 DOWN        │
│ Last Check: 30 seconds ago          │
│                                     │
│ [📊 View Logs] [🔄 Restart]         │
│ [⚙️  Fix Config] [🧪 Diagnose]      │
└─────────────────────────────────────┘
```

**Advantages:**

- User-friendly GUI
- Works across devices (phone, tablet, laptop)
- Secure (Tailscale handles auth)

**Disadvantages:**

- Requires Tailscale setup
- Limited to Tailscale network

**Implementation details:**

- Minimal Express.js server
- SSE (Server-Sent Events) for live log streaming
- Tailscale auth via `/whois` API
- Rate limiting per IP
- No external CDN dependencies (inline CSS/JS)

### 6. mDNS/Bonjour Discovery

**Implementation:** Advertise rescue agent on local network for auto-discovery.

```bash
# macOS
$ dns-sd -B _openclaw-rescue._tcp

# Linux (avahi)
$ avahi-browse -t _openclaw-rescue._tcp

# Returns:
Service: OpenClaw Rescue (Argos's Mac mini)
Address: 192.168.1.100:7878
```

**Advantages:**

- Zero-config discovery on LAN
- Works when internet is down
- Great for mobile apps

**Disadvantages:**

- LAN only
- Requires mDNS support

**Implementation details:**

- Advertise service using `bonjour` (Node.js)
- TXT record includes: version, status, capabilities
- Auto-update TXT record when status changes

### 7. SMS via Twilio (Optional)

**Implementation:** Send SMS commands, receive status updates.

```
You: "rescue status" → +1-555-OPENCLAW

OpenClaw: Main gateway DOWN. Auto-restart failed (3/3).
Last error: Port 3000 in use. Reply FIX to attempt repair.

You: "FIX"

OpenClaw: 🔧 Killing process on port 3000... ✅
Restarting gateway... ✅ Gateway is UP.
```

**Advantages:**

- Works without internet (cellular)
- Most reliable fallback
- Accessible from any phone

**Disadvantages:**

- Costs money (Twilio fees)
- SMS delays
- Limited command interface

**Implementation details:**

- Twilio webhook for incoming SMS
- Rate limiting: 10 SMS per hour max
- Commands: `status`, `restart`, `fix`, `logs`
- Auto-reply with status on any SMS

### 8. Physical Hardware Button (Advanced)

**Implementation:** GPIO button on Raspberry Pi triggers rescue.

```python
# Pseudo-code
button.when_pressed = lambda: subprocess.run(['openclaw', 'rescue', 'emergency-restart'])
```

**Advantages:**

- Works when ALL network is down
- Physical confirmation of action
- No auth needed (physical access = auth)

**Disadvantages:**

- Requires GPIO hardware
- Limited to one action

**Implementation details:**

- Raspberry Pi GPIO pin connected to button
- Python script listens for button press
- Trigger: Emergency restart of main gateway
- LED feedback for status

---

## Capabilities

The Rescue Agent is NOT read-only—it can take corrective actions with appropriate guardrails.

### 1. Config Read & Edit

**Read:**

- Parse and validate `~/.openclaw/config.json`
- Detect syntax errors (trailing commas, missing quotes)
- Identify missing required fields
- Check for deprecated settings

**Edit:**

- Fix syntax errors automatically
- Correct common typos (e.g., `telegram_token` → `telegramToken`)
- Remove invalid fields
- Add missing required fields with safe defaults

**Guardrails:**

- Always create backup: `config.json.backup.TIMESTAMP`
- Validate after edit: Must parse as valid JSON
- Diff preview before applying (when interactive)
- Audit log every config change
- Limit: Max 10 auto-edits per hour (prevent loops)

**Example AI prompt:**

```
You are the OpenClaw Rescue Agent. Analyze this config file and fix any errors:

[config.json contents]

Rules:
- Fix syntax errors (trailing commas, missing quotes)
- Do NOT change functional settings unless clearly wrong
- Explain each change you make
- Return the fixed config
```

### 2. Log Analysis

**Capabilities:**

- Read from `~/.openclaw/logs/gateway.log`
- Extract error stack traces
- Identify common error patterns
- Summarize recent activity

**AI-powered insights:**

```
User: /rescue diagnose

Rescue Agent:
🔍 Analyzing last 500 log lines...

Found 3 issues:

1. ❌ CRITICAL: Uncaught exception in Telegram plugin
   Pattern: "TypeError: Cannot read property 'id' of undefined"
   Frequency: 47 times in last 10 minutes
   Likely cause: Missing user validation in message handler

2. ⚠️  WARNING: Redis connection timeout
   Pattern: "Error: connect ETIMEDOUT"
   Frequency: 12 times in last hour
   Likely cause: Redis server not running or firewall issue

3. 💡 INFO: High memory usage trend
   Current: 1.2GB (up from 800MB 2 hours ago)
   Likely cause: Memory leak in session manager

Suggested actions:
- Restart gateway (will clear memory leak)
- Check if Redis is running: systemctl status redis
- Review Telegram plugin code at line 342
```

### 3. Process Control

**Capabilities:**

- Restart main gateway: `openclaw gateway restart`
- Stop main gateway: `openclaw gateway stop`
- Start main gateway: `openclaw gateway start`
- Check status: `openclaw gateway status`

**Guardrails:**

- Confirm before stop (unless emergency)
- Wait for graceful shutdown (30s timeout)
- Log all start/stop actions
- Rate limit: Max 3 restarts per 10 minutes (prevent restart loops)

### 4. Common Problem Diagnosis

The Rescue Agent includes AI-powered diagnostics for common issues:

**Pattern matching:**

```javascript
const commonErrors = [
  {
    pattern: /EADDRINUSE.*:(\d+)/,
    diagnosis: "Port {port} is already in use",
    fix: "Kill process using port {port}",
    command: "lsof -ti:{port} | xargs kill -9",
  },
  {
    pattern: /Cannot find module ['"](.*)['"]/,
    diagnosis: "Missing Node.js module: {module}",
    fix: "Reinstall dependencies",
    command: "cd ~/.openclaw && npm install",
  },
  {
    pattern: /Unexpected token.*in JSON/,
    diagnosis: "Config file has JSON syntax error",
    fix: "Auto-fix config syntax",
    command: "rescue fix-config",
  },
];
```

**AI diagnosis for unknown errors:**

- Send error + context to AI model
- Request diagnosis and fix steps
- Present to user with confidence score
- Require confirmation before executing fixes

### 5. Config Rollback

**Implementation:**

- Automatic backup on every config change: `config.json.backup.TIMESTAMP`
- Keep last 10 backups
- Rollback command: `openclaw rescue rollback [timestamp]`

```bash
$ openclaw rescue rollback --list

Available backups:
  2026-02-07-10:30:15  (30 minutes ago) - Before auto-fix
  2026-02-07-09:15:42  (2 hours ago) - Before manual edit
  2026-02-06-18:45:12  (17 hours ago) - Before plugin update

$ openclaw rescue rollback 2026-02-07-09:15:42

✅ Config rolled back to 2026-02-07 09:15:42
✅ Backup created: config.json.backup.2026-02-07-11:05:30
Restart gateway to apply? (yes/no)
```

### 6. Arbitrary Command Execution

**Guardrails:**

- Whitelist of allowed commands (configurable)
- Confirmation required for dangerous commands
- Dry-run mode available
- Audit logging of all commands
- Timeout: 30 seconds max execution time

**Command categories:**

```javascript
const commandSafety = {
  safe: ["ls", "cat", "grep", "ps", "systemctl status"],
  dangerous: ["rm", "kill", "systemctl stop", "npm uninstall"],
  requireConfirmation: ["git reset", "npm install", "node"],
  blocked: ["rm -rf", "sudo rm", "dd if="],
};
```

**Example:**

```
User: /rescue exec "kill 12847"

Rescue Agent:
⚠️  CONFIRMATION REQUIRED

Command: kill 12847
Category: DANGEROUS
Risk: Will terminate process 12847 (node)

Proceed? (yes/no)

User: yes

Rescue Agent:
✅ Executed: kill 12847
📋 Output: (none)
```

### 7. OpenClaw Updates

**Capabilities:**

- Check for updates: `git fetch origin`
- View changelog: `git log HEAD..origin/main`
- Update code: `git pull origin main`
- Reinstall dependencies: `npm install`

**Guardrails:**

- Updates disabled by default (require opt-in)
- Backup current version before update
- Rollback command if update fails
- Test gateway start after update (don't leave it broken)

**Example:**

```
User: /rescue update --check

Rescue Agent:
📦 Update available: v2.5.0 → v2.6.0

Changelog:
- Fix: Telegram webhook stability
- Feature: New /remember command
- Security: Patch for auth bypass

Install update? (yes/no)

User: yes

Rescue Agent:
✅ Backed up current version
✅ Pulled latest code (v2.6.0)
✅ Installed dependencies
✅ Started gateway
✅ Health check passed

Update complete! 🎉
```

### 8. Service Management (launchd/systemd)

**macOS (launchd):**

```bash
$ openclaw rescue service status
LaunchAgent: com.openclaw.gateway
State: running
PID: 12847
Uptime: 2 hours

$ openclaw rescue service restart
✅ Unloaded com.openclaw.gateway
✅ Loaded com.openclaw.gateway
✅ Service started (PID: 12901)
```

**Linux (systemd):**

```bash
$ openclaw rescue service status
Unit: openclaw.service
State: active (running)
PID: 12847
Uptime: 2 hours

$ openclaw rescue service restart
✅ Stopped openclaw.service
✅ Started openclaw.service
✅ Service is active
```

---

## Stability

The Rescue Agent must survive when the main gateway dies.

### Process Supervision

**Option 1: System service (recommended)**

macOS (LaunchAgent):

```xml
<!-- ~/Library/LaunchAgents/com.openclaw.rescue.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.openclaw.rescue</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/openclaw</string>
    <string>rescue</string>
    <string>start</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
```

Linux (systemd):

```ini
# /etc/systemd/system/openclaw-rescue.service
[Unit]
Description=OpenClaw Rescue Agent
After=network.target

[Service]
Type=simple
User=openclaw
ExecStart=/usr/local/bin/openclaw rescue start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Option 2: PM2 (alternative)**

```bash
$ pm2 start "openclaw rescue start" --name openclaw-rescue
$ pm2 startup
$ pm2 save
```

### Minimal Dependencies

**Required:**

- Node.js runtime (v18+)
- AI provider API (Anthropic/OpenAI/Google)
- Filesystem access

**Optional (degrade gracefully):**

- Telegram bot token (for Telegram access)
- Email credentials (for email access)
- Twilio credentials (for SMS access)

**Shared with main gateway:**

- Config files (`~/.openclaw/`)
- Log files (`~/.openclaw/logs/`)
- Database (read-only access)

**NOT required:**

- Redis
- PostgreSQL (unless main gateway requires it)
- Any OpenClaw plugins

### Self-Healing

The Rescue Agent should recover from its own failures:

1. **AI provider outage:**
   - Fallback to secondary model
   - If all AI fails, use deterministic rules
   - Alert user about degraded capabilities

2. **Config corruption:**
   - Load last known-good config
   - Reset to defaults if all backups corrupted
   - Create emergency config in `/tmp/`

3. **Disk full:**
   - Rotate logs aggressively
   - Delete old backups
   - Alert user

4. **Process crash:**
   - Handled by process supervisor (systemd/launchd)
   - Log crash reason
   - Restart with exponential backoff

---

## Security

The Rescue Agent has powerful capabilities and must be secured carefully.

### Authentication

**Per-access-method auth:**

1. **Telegram:**
   - Whitelist of allowed user IDs
   - Check `message.from.id` against `rescue.json` config
   - No fallback to "admin" user (explicit list only)

2. **Email:**
   - Whitelist of allowed sender addresses
   - Verify SPF/DKIM (if possible)
   - Subject-line passphrase (optional)

3. **SSH:**
   - Uses system SSH auth (pubkey or password)
   - Additional command-line flag: `--rescue-token=<secret>`
   - Token stored in `~/.openclaw/rescue.token` (auto-generated)

4. **Unix Socket:**
   - File permissions (`0600` = owner only)
   - Optional: Require token in JSON payload

5. **Web UI:**
   - Tailscale Whois API for user identity
   - Session cookies (httpOnly, secure)
   - CSRF tokens on all POST requests

6. **SMS:**
   - Whitelist of phone numbers
   - Rate limiting (10 SMS/hour max)
   - Optional: PIN code on first SMS

### Dangerous Operation Guardrails

**Confirmation required for:**

- Deleting files
- Killing processes (except whitelisted)
- Modifying configs (unless auto-fix mode)
- Running commands outside whitelist
- Updating OpenClaw

**Automatic safeguards:**

- Backup before any destructive action
- Dry-run mode available for all commands
- Timeout on all command execution (30s default)
- Rate limiting on restarts (prevent loops)
- Audit log (cannot be disabled)

**Example confirmation flow:**

```
User: /rescue exec "rm -rf ~/.openclaw/logs"

Rescue Agent:
⛔ BLOCKED: This command is not allowed

Command: rm -rf ~/.openclaw/logs
Reason: Matches blocked pattern: rm -rf

Alternative: Use 'openclaw rescue logs --clear' to safely clear logs
```

### Audit Logging

**All actions logged to: `~/.openclaw/logs/rescue-audit.log`**

Format (JSON lines):

```json
{"timestamp":"2026-02-07T11:05:30Z","action":"config_edit","user":"telegram:123456789","details":{"file":"config.json","changes":"Fixed syntax error"},"success":true}
{"timestamp":"2026-02-07T11:06:15Z","action":"process_restart","user":"ssh:alice","details":{"service":"gateway"},"success":true}
{"timestamp":"2026-02-07T11:07:42Z","action":"command_exec","user":"telegram:987654321","details":{"command":"kill 12847"},"success":false,"error":"Unauthorized user"}
```

**Audit log features:**

- Append-only (cannot be modified by rescue agent)
- Rotated daily (keep 90 days)
- Indexed for search: `openclaw rescue audit --search "config_edit"`
- Alert on suspicious activity (e.g., many failed auth attempts)

### Preventing Vulnerabilities

**Threat model:**

1. **Attacker gains Telegram access:**
   - Mitigated by: User ID whitelist
   - Fallback: Rate limiting, confirmation for dangerous ops

2. **Config injection attack:**
   - Mitigated by: JSON schema validation
   - Fallback: Restore from backup

3. **Command injection:**
   - Mitigated by: No shell execution (use spawn, not exec)
   - Fallback: Command whitelist

4. **Rescue agent compromise:**
   - Mitigated by: Minimal privileges (no root)
   - Fallback: Audit logging captures actions

5. **Denial of service:**
   - Mitigated by: Rate limiting on all access methods
   - Fallback: Auto-block after N failed attempts

**Security best practices:**

- Never log sensitive data (tokens, passwords)
- Use parameterized commands (no string interpolation)
- Validate all user input
- Principle of least privilege
- Regular security audits

---

## Proactive Monitoring

The Rescue Agent doesn't just wait for user commands—it actively monitors health.

### Health Checks

**Check types:**

1. **HTTP health endpoint:**
   - `GET http://localhost:3000/health`
   - Expect: 200 OK within 5 seconds
   - Frequency: Every 30 seconds

2. **Process existence:**
   - Check if main gateway PID exists
   - Frequency: Every 30 seconds

3. **Log activity:**
   - Detect if logs are being written
   - Stale logs = possible hang
   - Frequency: Every 2 minutes

4. **Resource usage:**
   - Memory usage (warn if >90%)
   - CPU usage (warn if >90% for 5 min)
   - Disk space (warn if <1GB free)
   - Frequency: Every 5 minutes

### Auto-Restart Logic

**Trigger:** 3 consecutive failed health checks

**Process:**

1. Log health check failure
2. Attempt graceful restart: `openclaw gateway restart`
3. Wait 30 seconds
4. Check if gateway is now healthy
5. If still down, try again (max 3 attempts)
6. If all attempts fail, alert user

**Restart backoff:**

- Attempt 1: Immediate
- Attempt 2: Wait 1 minute
- Attempt 3: Wait 5 minutes
- After 3 failures: Stop auto-restart, alert user

**Prevention of restart loops:**

- Max 3 restarts per 10 minutes
- If gateway crashes 3 times in 10 min, stop auto-restart
- Alert user: "Gateway is crash-looping, needs manual intervention"

### Alerting

**Alert channels (configurable):**

1. Telegram message
2. Email
3. SMS (if configured)
4. System notification (macOS/Linux desktop)

**Alert triggers:**

1. **Main gateway down:**
   - Severity: CRITICAL
   - Message: "🚨 OpenClaw gateway is DOWN. Auto-restart attempt 1/3..."

2. **Auto-repair successful:**
   - Severity: INFO
   - Message: "✅ OpenClaw gateway auto-repaired. Issue: Port conflict. Action: Killed orphaned process."

3. **Auto-repair failed:**
   - Severity: WARNING
   - Message: "⚠️ OpenClaw gateway restart failed (3/3 attempts). Manual intervention required. /rescue diagnose for details"

4. **Auth failure:**
   - Severity: WARNING
   - Message: "🔒 Unauthorized rescue access attempt from user 123456789"

5. **Resource warning:**
   - Severity: WARNING
   - Message: "💾 Disk space low: 500MB remaining"

**Quiet hours:**

- Don't alert between 23:00 and 08:00 (configurable)
- Exception: CRITICAL alerts always sent

### Escalation

**If auto-fix fails, escalate to user:**

1. Send alert via all configured channels
2. Provide diagnosis and suggested actions
3. Offer one-click fixes (if available)
4. Include link to logs and status

**Example escalation message:**

```
🚨 CRITICAL: OpenClaw gateway failed to start

Auto-restart attempts: 3/3 (all failed)

Last error:
  Error: listen EADDRINUSE: address already in use :::3000

Diagnosis:
  Port 3000 is occupied by process 12847 (node)

Suggested fix:
  /rescue exec "lsof -ti:3000 | xargs kill -9"

Or view full diagnostics:
  /rescue diagnose
```

---

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1-2)

- [ ] Separate process architecture
- [ ] Basic CLI: `openclaw rescue start/stop/status`
- [ ] Config file: `rescue.json` with schema validation
- [ ] Health check monitor (HTTP + process)
- [ ] Audit logging

### Phase 2: AI Integration (Week 3)

- [ ] Model selection and fallback logic
- [ ] Log analysis with AI
- [ ] Config auto-fix with AI
- [ ] Diagnostic AI prompts

### Phase 3: Access Methods (Week 4-5)

- [ ] Telegram `/rescue` commands
- [ ] SSH shell interface
- [ ] Unix socket API
- [ ] Email monitoring (optional)

### Phase 4: Capabilities (Week 6)

- [ ] Process control (restart/stop/start)
- [ ] Config rollback
- [ ] Command execution with guardrails
- [ ] Service management (launchd/systemd)

### Phase 5: Monitoring & Alerts (Week 7)

- [ ] Auto-restart logic
- [ ] Alerting system
- [ ] Quiet hours
- [ ] Escalation flow

### Phase 6: Advanced Access (Week 8+)

- [ ] Tailscale web UI
- [ ] mDNS discovery
- [ ] SMS via Twilio (optional)

---

## Open Questions

1. **Model token costs:** Should we set a daily budget limit for AI calls?
2. **Update strategy:** Should rescue agent auto-update itself, or require main gateway to update it?
3. **Database access:** Should rescue agent have write access to DB, or read-only?
4. **Config sync:** Should rescue agent config live in main `config.json`, or always separate?
5. **Multi-instance:** Should rescue agent support monitoring multiple OpenClaw instances on same machine?

---

## Alternatives Considered

### Alternative 1: Extend Main Gateway with "Safe Mode"

**Pros:** No separate process, simpler architecture  
**Cons:** If main gateway crashes hard, safe mode won't help  
**Decision:** Rejected. Separate process is critical for reliability.

### Alternative 2: Simple Restart Script (No AI)

**Pros:** Simple, lightweight, no API costs  
**Cons:** Can't diagnose or fix complex issues  
**Decision:** Rejected. AI is core to the value proposition.

### Alternative 3: Cloud-based Monitoring Service

**Pros:** Works even if server is completely down  
**Cons:** Requires external service, privacy concerns  
**Decision:** Rejected for initial version. Could be future enhancement.

---

## Success Metrics

1. **Mean Time To Recovery (MTTR):** Average time from gateway failure to recovery
   - Target: <5 minutes with auto-restart
   - Baseline: ~30 minutes (current manual recovery)

2. **Auto-fix success rate:** % of failures fixed without human intervention
   - Target: >70% for common issues

3. **User satisfaction:** Survey users who've used rescue agent
   - Target: >4.5/5 stars

4. **Rescue agent uptime:** % time rescue agent is running
   - Target: >99.9%

---

## References

- [OpenClaw Gateway Documentation](../gateway/README.md)
- [Configuration Schema](../gateway/configuration.md)
- [Security Best Practices](../gateway/security/README.md)
- [Monitoring & Observability](../gateway/monitoring.md)

---

## Changelog

- **2026-02-07:** Initial draft

---

_This is a living document. Feedback and iterations welcome._
