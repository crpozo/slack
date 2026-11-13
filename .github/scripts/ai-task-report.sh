#!/usr/bin/env bash
# Reports a board task's progress from the `ai-task` workflow (Phase 65): invokes
# the tasks Lambda directly, signed by the workflow's AWS role. No public
# endpoint and no shared secret. Usage: ai-task-report.sh <running|deploying|done|failed>
set -euo pipefail
phase="$1"
summary=""
if [ -s "${RUNNER_TEMP:-/tmp}/summary.txt" ]; then
  summary=$(head -c 1800 "${RUNNER_TEMP:-/tmp}/summary.txt")
fi
payload=$(jq -n \
  --arg taskId "$TASK_ID" \
  --arg phase "$phase" \
  --arg runUrl "${RUN_URL:-}" \
  --arg commit "${COMMIT:-}" \
  --arg summary "$summary" \
  '{aiTask: ({taskId: $taskId, phase: $phase, runUrl: $runUrl}
     + (if $commit == "" then {} else {commit: $commit} end)
     + (if $summary == "" or $phase == "running" then {} else {summary: $summary} end))}')
aws lambda invoke \
  --function-name "$TASKS_FUNCTION" \
  --cli-binary-format raw-in-base64-out \
  --payload "$payload" \
  /dev/null > /dev/null
echo "reported: $phase"
