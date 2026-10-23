#!/usr/bin/env bash
# forgejo-gh-failure-log — post the tail of a failed Forgejo job's step log to
# GitHub as a COMMIT COMMENT on the gated sha.
#
# Why: Forgejo job logs are only readable with a browser session (the API and
# token-authenticated web routes return the sign-in page), so an agent with the
# GitHub CLI can see THAT build-check-test failed but never WHY. Every gate run
# on this fork failed for weeks with the cause unreadable. The status bridge
# already holds a GitHub token; this reuses it to surface the evidence where
# `gh api repos/<repo>/commits/<sha>/comments` can read it.
#
# Env contract: GH_STATUS_TOKEN, GH_REPO, GH_SHA as for forgejo-gh-status.sh;
#   CI_LOG     path of the log the steps tee into (missing file = nothing to post)
#   LOG_TITLE  heading for the comment (optional)
#   LOG_URL    link to the Forgejo run (optional)
# Steps tee into CI_LOG, so only command output reaches it; secrets are passed
# through env and never echoed.
set -eu

: "${GH_STATUS_TOKEN:?GH_STATUS_TOKEN missing}" "${GH_REPO:?GH_REPO missing}" \
  "${GH_SHA:?GH_SHA missing}" "${CI_LOG:?CI_LOG missing}"

[ -s "$CI_LOG" ] || { echo "forgejo-gh-failure-log: no log at $CI_LOG" >&2; exit 0; }

# GitHub caps comment bodies at 65536 characters; keep the tail, where the
# failure is, with room for the heading.
body=$(LOG_TAIL="$(tail -c 60000 "$CI_LOG")" node -e '
const { LOG_TITLE = "Forgejo job failed", LOG_URL = "", LOG_TAIL } = process.env;
const fence = "~~~~";
process.stdout.write(JSON.stringify({
	body: `${LOG_TITLE}${LOG_URL ? ` — ${LOG_URL}` : ""}\n\nLast 60 kB of step output:\n\n${fence}\n${LOG_TAIL.replaceAll(fence, "~~~")}\n${fence}\n`,
}));
')

curl -fsS -X POST \
  -H "Authorization: Bearer $GH_STATUS_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$GH_REPO/commits/$GH_SHA/comments" \
  --data-binary "$body" >/dev/null
echo "forgejo-gh-failure-log: posted $(wc -c <"$CI_LOG") bytes (tail) to $GH_REPO@$GH_SHA"
