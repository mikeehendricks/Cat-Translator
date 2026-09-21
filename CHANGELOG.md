# Changelog

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
