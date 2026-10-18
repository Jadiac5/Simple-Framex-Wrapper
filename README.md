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

## Install on the TV

The TV needs "unknown sources" / "install unknown apps" enabled for whichever tool you use.

**With adb** (TV and PC on the same network, developer options + network debugging on):

```bash
adb connect <tv-ip>:5555
adb install -r Simple-Framex-Wrapper.apk
```

**Without a PC:** put the APK on a USB stick, or open the release page in the *Downloader* app on the TV.

The app shows up in the TV launcher as **frameXTV** (it has a banner for the Android TV home screen).


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

- **Page size** – 75 %…150 %. The site is laid out for a smaller/larger screen. Remembered between launches.
  Try 110–125 % if text is too small from the couch.
- **Clear cache**, **Reload page**, **Go to home page**, **Exit frameXTV**.

## Build it yourself

Requirements: JDK 21 (Gradle 8.14 / Android Gradle Plugin 8.13), Android SDK with platform 35
(`ANDROID_HOME` or `local.properties`). Internet access for the first build.

```bash
./gradlew assembleRelease     # app/build/outputs/apk/release/frameXTV-1.1.0-release.apk
./gradlew assembleDebug       # debuggable build, logs key handling under logcat tag "frameXTV"
```

On Windows use `gradlew.bat`.

Project layout:

- `app/src/main/java/xyz/framextv/tv/MainActivity.java` – WebView setup, key handling, Back, fullscreen video,
  options dialog, error page, script injection (document-start, restricted to framextv.xyz / framextv.tech).
- `app/src/main/assets/tvnav.js` – the TV navigation: finds focusable things, picks the next one in the pressed
  direction, draws the ring, handles popups, text fields and the player.
- `app/src/main/assets/error.html` – offline page with a Retry button.

## Things to know

- **Speed:** the script keeps a cached map of what is on screen, turns off the site's CSS transitions and
  backdrop blur (these are what make weak TV GPUs stutter) and throttles held-down keys, so a move costs a few
  milliseconds instead of a full page scan. If it still feels slow, lower **Page size** in the Menu.
- **Fullscreen:** while a player is fullscreen the page behind it is parked at the top and the player is kept
  from scrolling, so the picture can't sit shifted up with a black band underneath.

- Only `framextv.xyz` and `framextv.tech` open inside the app; any other link is blocked / not followed.
- The screen is kept awake while the app is open.
- Official release APKs are signed with the maintainer's release key by GitHub Actions (push a `v*` tag). It is a
  sideload build, not a Play Store build.
- Third-party players on other sites inside iframes (cross-origin) can't be steered by the script; there you only
  get raw keys. The site's own player (`/embed/...`) is fully supported.
- If the site changes its layout the navigation adapts (it works from what is on screen, not from fixed
  selectors), but a big redesign of the player controls could need a tweak in `tvnav.js`.

## How it was tested

Built and run on an Android 14 emulator (WebView 113, 1920×1080), driving it only with adb key events:
home/rails/header navigation, details page, search with the on-screen keyboard, watch page, player in
fullscreen (OK, Up/Down controls, settings menu, Back unwinding), media keys, options dialog, double-Back exit,
and the release build. Random D-pad walks (about 40 moves each, with every move checked for going the wrong
way) were run over the home page, movies, a series page, anime, search, history and my list.
**Not tested on a physical TV** – remotes vary, so if a particular key does nothing, the debug build logs what
arrives. Speed numbers come from the emulator with the CPU slowed down 6×, which is only an estimate of a TV.
