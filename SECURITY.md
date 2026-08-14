Security Policy

Overview

DeepSeek Local Agent prioritizes security with local-only operation, user approval controls, and comprehensive audit logging.

Core Security Principles

- Least Privilege
- Local Only Operation
- User Control and Approval
- Audit Trail
- Workspace Boundaries
- Defense in Depth

Security Features

Authentication
- Unique pairing token per daemon instance
- Token stored at ~/.deepseek-local/token
- Extension requires valid token for connection
- Tokens can be regenerated

Network Security
- Binds to 127.0.0.1 only (localhost)
- Default port 43121
- No external network exposure
- No cloud dependencies

File System Security
- Workspace boundary enforcement
- Path traversal prevention
- Symlink validation
- delete_file only removes individual files
- write_file cannot overwrite system files
- edit_file requires explicit approval

Command Execution Security
- High-risk command blocklist
- All commands require approval by default
- Commands logged regardless of approval status

Auto-Approval Controls
- Disabled by default
- Must be explicitly enabled
- Per-project or global settings
- Project settings override global

Audit Logging
- SQLite database at ~/.deepseek-local/history.db
- Logs: timestamp, tool name, arguments, user, status, errors
- Query and backup capabilities

Extension Security
- Content Security Policy enforced
- No inline scripts
- Limited Chrome permissions
- Content script isolation

Best Practices

For Users
1. Keep daemon on localhost only
2. Review approvals carefully
3. Secure pairing token
4. Audit history regularly
5. Keep dependencies updated
6. Use with trusted projects only

For Developers
1. Validate all inputs
2. Implement defense in depth
3. Follow secure coding practices
4. Conduct regular security reviews
5. Keep dependencies secure with npm audit

Threat Model

Table: Potential Threats and Mitigations
- Malicious AI Instructions: Tool misuse, mitigation with approval system and blocklist
- Path Traversal: Access outside workspace, mitigation with path validation
- Unauthorized Access: Data breach, mitigation with token auth and localhost
- Command Injection: System compromise, mitigation with sanitization and blocklist
- Token Theft: Unauthorized access, mitigation with secure storage

Reporting Vulnerabilities

Email: security@deepseek-local-agent.com

Process:
1. Do not disclose publicly
2. Email with details and steps to reproduce
3. Expect acknowledgment within 24-48 hours
4. Coordinated disclosure after fix

Security Checklist

Installation
- Node.js 20+ installed
- Dependencies updated with npm update
- No vulnerabilities with npm audit
- Daemon on 127.0.0.1
- Workspace path set
- Token secured

Daily Usage
- Daemon bound to localhost
- Auto-approval disabled
- History reviewed periodically
- No suspicious activity
- Token not exposed

Incident Response

If breach suspected:
1. Stop daemon: pkill -f daemon
2. Revoke token: rm ~/.deepseek-local/token
3. Disable extension in chrome://extensions/
4. Investigate with git status and logs
5. Regenerate tokens and restore from backup
6. Document and implement improvements

Security Updates

git pull origin main
npm update
npm audit
npm audit fix
npm run build
npm start

Resources

- OWASP Top 10
- CWE Top 25
- Node.js Security Best Practices
- Chrome Extension Security

Contact

Email: security@deepseek-local-agent.com

Final Reminder

Security is a shared responsibility. Think before approving, review AI requests, monitor your system, keep everything updated, and stay informed.

Last Updated: 2026-08-14
Version: 1.0.0
