# Simple Framex Wrapper – Android TV app for framextv.xyz

> Unofficial, open-source and not affiliated with framextv.xyz. No content is hosted in this repo; the app just opens the public website in a WebView. Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed.

A small Android TV app (APK) that opens **https://framextv.xyz** full screen and lets you drive it with the
normal TV remote: arrow keys, OK, Back, play/pause. No mouse cursor.

It is a native `WebView` wrapper (same idea as the AniLo wrapper) plus a spatial-navigation script
(`app/src/main/assets/tvnav.js`) that is injected into the site and into its player iframe. The website itself
is not modified and keeps updating on its own.

Ready-to-install file: download **`Simple-Framex-Wrapper.apk`** from the [latest release](../../releases/latest).

## Updates

On every cold start the app checks this repo's latest GitHub release. If a newer version exists, it shows an
**Update** / **Go to website** screen first (Back or OK on *Go to website* skips it); otherwise, or if you are
offline, it opens the site directly. *Update* downloads the APK inside the app and opens the system installer.
The first time, Android asks you to allow "Install unknown apps" for this app. Updates only install over
official releases (same signing key); builds you compile yourself use your debug key and can't update them.

## Remote controls

| Key | What it does |
| --- | --- |
| Arrow keys | Move the green selection ring to the nearest item in that direction (cards, menus, buttons, rails scroll as needed) |
| OK | Click the selected item. On a text field it opens the on-screen keyboard |
| Back | Undo one level: close keyboard → close player menu → leave player controls → leave fullscreen → close popup → previous page → (on the home page) press twice to exit |
| Menu / Info / Settings | App options: reload, go to home page, page size, clear cache, exit |
| Play/Pause, Play, Pause, Stop, FF, Rewind | Control the video (FF/Rewind jump 10 s) |

**On the watch page:**

- Press **OK** on the player once to start it and go fullscreen.
- In fullscreen: **OK** = play/pause, **Left/Right** = skip 10 s, **Up/Down** = show the player controls and
  move between them (play, mute, subtitles, settings, server, fullscreen, timeline). **Left/Right** on the
  timeline seeks.
- **Back** closes a player menu first, then the controls, then fullscreen, then leaves the player.

## Options (Menu key)

- **Page size** – 50 %…125 % (default 75 %). Remembered between launches.
- **Clear cache**, **Reload page**, **Go to home page**, **Exit frameXTV**.
