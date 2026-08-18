export class DelegationPolicy {
  constructor(maxCalls = 12) {
    this.maxCalls = maxCalls;
    this.calls = 0;
  }

  request(prompt) {
    if (!/\bTASK_ID:\s*TASK-[A-Za-z0-9.-]+/.test(prompt)) {
      return { allowed: false, reason: "STATUS: BLOCKED\nREASON: delegated task is missing TASK_ID" };
    }
    if (this.calls >= this.maxCalls) {
      return { allowed: false, reason: "STATUS: PARTIAL\nREASON: delegation limit reached" };
    }
    this.calls += 1;
    return { allowed: true, number: this.calls };
  }
}

export const dangerousCommand = /(?:^|[;&|]\s*)(?:sudo\b|rm\b|shutdown\b|reboot\b|poweroff\b|mkfs\b|mount\b|umount\b|systemctl\b|service\b|kill(?:all)?\b|pkill\b|dd\b|chmod\b|chown\b)|\bgit\s+(?:push|commit|merge|rebase|reset|clean|checkout|switch)\b/i;
