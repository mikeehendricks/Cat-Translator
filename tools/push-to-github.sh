#!/usr/bin/env bash
#
# Push this repository to GitHub.
#
#   GITHUB_TOKEN=... ./tools/push-to-github.sh
#   ./tools/push-to-github.sh --token <token> --branch main
#
# The token must have WRITE access to the repository:
#
#   fine-grained token  → Repository access: mikeehendricks/Cat-Translator
#                         Permissions → Contents: Read and write
#   classic token       → scope "public_repo" (public repositories)
#                         or "repo" (private repositories)
#
# A read-only token produces "Resource not accessible by personal access token"
# (403) from the API, or "Permission ... denied" from git. This script checks
# first, so you get that answer in one line instead of a confusing git error.
#
set -euo pipefail

TOKEN="${GITHUB_TOKEN:-}"
BRANCH="main"
REMOTE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="${2:?}"; shift 2;;
    --branch) BRANCH="${2:?}"; shift 2;;
    --remote) REMOTE="${2:?}"; shift 2;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \?//'; exit 0;;
    *) echo "unknown option: $1" >&2; exit 2;;
  esac
done

cd "$(git rev-parse --show-toplevel)"

if [ -z "$REMOTE" ]; then
  REMOTE="$(git remote get-url origin 2>/dev/null || true)"
fi
[ -n "$REMOTE" ] || { echo "no git remote — pass --remote https://github.com/owner/repo.git" >&2; exit 1; }
SLUG="$(printf '%s' "$REMOTE" | sed -E 's#(git@github\.com:|https?://[^/]+/)##; s#\.git$##')"
OWNER_REPO="${SLUG#*github.com/}"
[ -n "$OWNER_REPO" ] || { echo "could not work out owner/repo from $REMOTE" >&2; exit 1; }

if [ -z "$TOKEN" ]; then
  echo "usage: GITHUB_TOKEN=<token with Contents: Read and write> $0" >&2
  echo "       (create one at https://github.com/settings/tokens?type=beta)" >&2
  exit 1
fi

echo "==> repository: $OWNER_REPO"
echo "==> branch:     $BRANCH"
echo "==> local HEAD: $(git log --oneline -1)"

# ---- 1. is the token able to write at all? ---------------------------------
# Creating a blob writes a dangling object and changes nothing visible.
BLOB_STATUS="$(curl -s -o /tmp/.meow-blob-check -w '%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -d '{"content":"write-permission-check","encoding":"utf-8"}' \
  "https://api.github.com/repos/$OWNER_REPO/git/blobs")"
rm -f /tmp/.meow-blob-check

case "$BLOB_STATUS" in
  201) echo "  ok  the token can write to this repository" ;;
  403|404)
    echo
    echo "  !!  This token cannot write to $OWNER_REPO (HTTP $BLOB_STATUS:"
    echo "      \"Resource not accessible by personal access token\")."
    echo
    echo "      Fix it in one of two ways:"
    echo
    echo "      a) fine-grained token — https://github.com/settings/tokens?type=beta"
    echo "         Repository access: $OWNER_REPO"
    echo "         Permissions -> Contents: Read and write      (and Metadata: Read)"
    echo
    echo "      b) classic token — https://github.com/settings/tokens"
    echo "         scope: public_repo  (this repository is public)"
    echo
    echo "      Then: GITHUB_TOKEN=<new token> $0"
    echo
    exit 1
    ;;
  200|*)
    echo "  ??  unexpected response ($BLOB_STATUS) — trying the push anyway" ;;
esac

# ---- 2. push, without ever putting the token on the command line -----------
# A credential helper reads the token from the environment, so it never shows
# up in the process list or in .git/config.
export GITHUB_TOKEN="$TOKEN"
export MEOW_SLUG="$OWNER_REPO"
HELPER='!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f'

if git -c credential.helper="$HELPER" push "https://github.com/$OWNER_REPO.git" "$BRANCH" 2>/tmp/.meow-push-err; then
  rm -f /tmp/.meow-push-err
  echo
  echo "  pushed. $OWNER_REPO @ $BRANCH is now at $(git rev-parse --short HEAD)"
  echo
  echo "  Installed servers can now update from it:"
  echo "    sudo meow-translator update --check      # or the Updates tab in /admin"
  echo
else
  STATUS=$?
  echo
  echo "  push failed:" >&2
  sed 's/^/    /' /tmp/.meow-push-err >&2
  rm -f /tmp/.meow-push-err
  echo >&2
  if grep -q 'workflow' /tmp/.meow-push-err 2>/dev/null || true; then
    echo "  This push touches .github/workflows/, which needs an extra permission:" >&2
    echo "    fine-grained token -> Workflows: Read and write" >&2
    echo "    classic token      -> the 'workflow' scope" >&2
    echo "  Either add it and push again, or add the workflow file through the" >&2
    echo "  GitHub web UI (Add file -> Create new file)." >&2
    echo >&2
  fi
  echo "  If it says the branch is behind or non-fast-forward, the remote has" >&2
  echo "  commits this checkout does not:  git pull --rebase origin $BRANCH" >&2
  exit "$STATUS"
fi
