# Changelog

## 1.0.6

- **The service can run on a privileged port.** `sudo ./install.sh --port 80 --host 0.0.0.0` now
  works: the systemd unit grants `CAP_NET_BIND_SERVICE` (and its bounding set) so the unprivileged
  service can bind ports below 1024, without running as root and without weakening
  `NoNewPrivileges`.
- `doctor` checks that the unit grants that capability whenever the configured port is below 1024,
  and `--fix` rewrites the unit from the deployed template.
- Documented: changing the port on an existing install, the firewall, and why `trustProxy` should be
  false when nothing sits in front of the app.

## 1.0.5

- **The updates list marks the right row as running.** It used to mark the newest snapshot, which is
  the *pre-update* state — the version you would roll back to — and, because several snapshots can
  share a version number, it could mark several rows at once. A row is now marked only if it is the
  snapshot that was actually restored, or its commit is the one running.
- The server test picks a free port and refuses to start if one is already answering, after a
  crashed run left a server behind and the next run talked to that stale process instead of its own.

## 1.0.4

- **An undeletable old snapshot no longer aborts an update.** The service can only prune snapshots
  it owns; one left behind by another account (a root-run update on an older release) made the
  whole update fail with `EACCES` while removing `versions/…`. It now keeps the snapshot, reports
  exactly which one and why, and finishes the update.
- `doctor` now looks **inside** the application, data and snapshot trees, not just at the top-level
  entries — stray ownership was hiding in there, invisible to the old check. `--fix` repairs it.
- CLI-driven updates are written to the store's update log, so they appear in the `/admin` panel's
  update history exactly like updates started from the panel. Previously the CLI logged to the
  terminal only, and its warnings vanished when the process exited.
- Update and rollback warnings are returned to the panel and printed by the CLI instead of being
  swallowed.
- The CI workflow ships as `deploy/github/ci.yml`. It cannot live at
  `.github/workflows/ci.yml` in this repository until the access token carries the *Workflows: Read
  and write* permission (or the classic `workflow` scope) — GitHub refuses any push that touches a
  workflow file without it. Copy it into place once that permission is granted. Until then the
  scripts it runs can be executed by hand; see the README.

## 1.0.3

- **Regression test for the ownership bug** (`tools/test-ownership.mjs`, run as root, plus a CI
  step): it builds an installation owned by a different account, drives a root-run CLI command and
  a real update plus rollback against a stand-in GitHub, and asserts the service account can still
  read everything.
- Snapshot and staging directories now inherit the data directory's owner, including the first time
  a root-run command creates them.
- `meow-translator update` and `rollback` honour `restartMode: "off"` instead of restarting anyway,
  and accept `--flag=value` as well as `--flag value`.
- `doctor --skip-unit-check`, for hosts that do not run the systemd unit.

## 1.0.2

Fixes a bug that could take the service down after a command-line update.

- **Ownership is preserved when root runs the tooling.** `sudo meow-translator update`
  wrote the store and the application tree as root, which left the data directory unreadable
  to the unprivileged service account — the service then failed to start and its error looked
  like the visit log and credentials had vanished. Every root-run write path now hands the
  result back to the account that owns the surrounding directory, before and after a swap.
- **`meow-translator doctor`** checks the installation (ownership of the app, data, store and
  snapshot directories, store readability, `Restart=always` in the unit, free space) and
  `--fix` repairs what it can.
- Store permission errors now name the directory to chown and the service to restart, and are
  never treated as a corrupt file.

## 1.0.1

- `meow-translator update --check` now names the case instead of guessing: identical commit,
  newer version, same version with a different commit (a redeploy), or an older remote.
- Adds release notes, so the Update tab has something to point at besides the commit message.

## 1.0.0

First release.

- **The translator.** Text is synthesised into cat calls — glottal source, three-formant cascade,
  pitch contours in semitones, purr rumble, amplitude envelopes — and recordings are read back
  through energy segmentation, a 33-feature acoustic fingerprint per meow, and a per-class Gaussian
  classifier. Both directions share one codec, so the round trip is decodable.
  Measured 97.6 % top-1 on its own audio, 91.7 % on fresh voices, 66.5 % under noise and a muffled
  microphone; text → meow → text is exact for 31/31 test phrases.
- **Server.** Node standard library only, no npm dependencies.
- **Install.** `install.sh` for Ubuntu: Node.js, a dedicated `meow` system account, a systemd unit
  with `Restart=always`, optional nginx and Let's Encrypt.
- **Admin panel** at `/admin`: one-time registration behind a setup token, scrypt credentials,
  server-side sessions with CSRF and same-origin checks, login lockout, audit log, credential
  changes, on-demand restart.
- **Visit statistics**: IP address, location (asynchronous, cached, skippable), device, browser,
  referrer, CSV export, retention window, and a privacy mode that keeps only a salted hash.
- **Updates**: resolves the branch to a commit, refuses an archive that does not carry that sha,
  stages it, smoke-tests the staged copy, snapshots the running tree, swaps, restarts. Rollback
  restores any snapshot. Versions are shown on the app page, in the panel and in the CLI.
- **Tests**: 70 server checks including a real update-and-rollback round trip with the restart
  handshake, a jsdom UI test of the app, and an HTTP verification script for an installed instance.
