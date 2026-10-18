# Contributing

Ideas, bug reports and pull requests are welcome - this is a small community project.

## Ideas and bugs
Open an [issue](../../issues/new/choose). For bugs, please include your TV/device model, Android version, the app version (shown in the update screen / release page) and what the remote did vs. what you expected.

## Pull requests
1. Fork the repo and create a branch from `main`.
2. Build it (see the README, "Build it yourself") and try your change, ideally on a real remote.
3. Keep changes focused; describe what and why in the PR.
4. Don't commit keystores, `local.properties` or any secrets.

Builds from source are signed with your local debug key, so they can't update over the official release (uninstall first, or just use the official APK).

## Releases (maintainer)
Bump `versionCode` and `versionName` in `app/build.gradle`, commit, then push a matching tag:

```bash
git tag v1.2.0 && git push origin v1.2.0
```

GitHub Actions builds the signed APK and publishes it as a release. The in-app update check compares the release tag with the installed `versionName`, so the two must match.
