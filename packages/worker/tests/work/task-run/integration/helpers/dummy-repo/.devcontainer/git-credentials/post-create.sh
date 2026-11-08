#!/bin/sh
# postCreateCommand for the git credential relay integration test: run a real
# `git ls-remote` against the host-side stub HTTPS git server, which only
# answers once git's credential helper has supplied the relay's credential.
# The record lands in the workspace for the code step to read back.
# This runs as the container's root user on a bind-mounted workspace, so
# `.scarn/tmp` is opened up for the host-side worker, which writes the code
# step's input file there as an unprivileged user on Linux runners.
set -u
url="$1"
out=".scarn/tmp/git-credentials-post-create.txt"
mkdir -p .scarn/tmp
chmod 0777 .scarn/tmp
if git -c http.sslVerify=false ls-remote "$url" >"$out.refs" 2>"$out.err"; then
  status=0
else
  status=$?
fi
{
  echo "status=$status"
  cat "$out.refs"
} >"$out"
rm -f "$out.refs"
exit 0
