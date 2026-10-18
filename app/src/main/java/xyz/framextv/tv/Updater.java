package xyz.framextv.tv;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Looks for a newer GitHub release of this app and downloads/installs its APK.
 *
 * Only this repo's releases are trusted: the download URL must live under {@link #DOWNLOAD_PREFIX}
 * and the downloaded file must be this app (same package, higher version) before it is handed to
 * the system installer. Android itself additionally refuses APKs signed with a different key.
 */
final class Updater {

    static final String REPO = "Jadiac5/Simple-Framex-Wrapper";
    private static final String API_URL = "https://api.github.com/repos/" + REPO + "/releases/latest";
    private static final String DOWNLOAD_PREFIX = "https://github.com/" + REPO + "/releases/download/";
    private static final int TIMEOUT_MS = 7000;
    private static final String UPDATE_DIR = "updates";

    static final class Release {
        final String version;
        final String apkUrl;
        final long size;

        Release(String version, String apkUrl, long size) {
            this.version = version;
            this.apkUrl = apkUrl;
            this.size = size;
        }
    }

    interface Progress {
        /** @param total -1 when unknown */
        void onProgress(long done, long total);
    }

    interface Cancel {
        boolean isCancelled();
    }

    /** Why the last check found nothing because it failed (null when it simply was up to date). */
    static volatile String lastError;

    private Updater() {}

    /** Returns the latest release if it is newer than {@code currentVersion}, else null (also on any error). */
    static Release checkForUpdate(Context ctx, String currentVersion) {
        cleanup(ctx);
        lastError = null;
        HttpURLConnection c = null;
        try {
            c = open(API_URL);
            c.setRequestProperty("Accept", "application/vnd.github+json");
            if (c.getResponseCode() != 200) {
                lastError = "HTTP " + c.getResponseCode();
                return null;
            }
            JSONObject json = new JSONObject(readAll(c.getInputStream()));
            if (json.optBoolean("draft") || json.optBoolean("prerelease")) return null;
            String tag = json.optString("tag_name");
            if (!isNewer(tag, currentVersion)) return null;
            JSONArray assets = json.optJSONArray("assets");
            if (assets == null) return null;
            for (int i = 0; i < assets.length(); i++) {
                JSONObject a = assets.getJSONObject(i);
                String url = a.optString("browser_download_url");
                if (a.optString("name").endsWith(".apk") && url.startsWith(DOWNLOAD_PREFIX)) {
                    return new Release(tag.replaceFirst("^[vV]", ""), url, a.optLong("size", -1));
                }
            }
        } catch (IOException | JSONException | RuntimeException e) {
            // Offline, rate limited, malformed... the app simply carries on to the site.
            lastError = e.getClass().getSimpleName() + ": " + e.getMessage();
        } finally {
            if (c != null) c.disconnect();
        }
        return null;
    }

    private static final String PREFS = "updater";

    /** Remembers the outcome of a check (null = up to date) so a slow check still pays off on the next launch. */
    static void remember(Context ctx, Release r) {
        android.content.SharedPreferences.Editor e = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (r == null) {
            e.clear();
        } else {
            e.putString("version", r.version).putString("url", r.apkUrl).putLong("size", r.size);
        }
        e.apply();
    }

    /** A remembered release that is still newer than {@code currentVersion}, else null. */
    static Release cached(Context ctx, String currentVersion) {
        android.content.SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String v = p.getString("version", null), url = p.getString("url", null);
        if (v == null || url == null || !url.startsWith(DOWNLOAD_PREFIX) || !isNewer(v, currentVersion)) return null;
        return new Release(v, url, p.getLong("size", -1));
    }

    /** Downloads the release APK into the app cache and checks it really is a newer build of this app. */
    static File download(Context ctx, Release r, Progress progress, Cancel cancel) throws IOException {
        if (!r.apkUrl.startsWith(DOWNLOAD_PREFIX)) throw new IOException("Untrusted download URL");
        File dir = new File(ctx.getCacheDir(), UPDATE_DIR);
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("Cannot create cache folder");
        File out = new File(dir, "update.apk");
        HttpURLConnection c = open(r.apkUrl);
        c.setReadTimeout(15000);
        try {
            if (c.getResponseCode() != 200) throw new IOException("HTTP " + c.getResponseCode());
            long total = c.getContentLengthLong();
            if (total <= 0) total = r.size;
            try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                byte[] buf = new byte[32 * 1024];
                long done = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    if (cancel.isCancelled()) throw new IOException("Cancelled");
                    os.write(buf, 0, n);
                    done += n;
                    progress.onProgress(done, total);
                }
            }
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw e;
        } finally {
            c.disconnect();
        }
        if (!isNewerBuildOfThisApp(ctx, out)) {
            //noinspection ResultOfMethodCallIgnored
            out.delete();
            throw new IOException("Downloaded file is not a newer build of this app");
        }
        return out;
    }

    static Intent installIntent(Context ctx, File apk) {
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".updates", apk);
        return new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }

    static void cleanup(Context ctx) {
        File[] files = new File(ctx.getCacheDir(), UPDATE_DIR).listFiles();
        if (files == null) return;
        for (File f : files) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    // ---------------------------------------------------------------- helpers

    /** "v1.2.0" vs "1.1.0": compares dot separated numbers, ignoring any "-suffix". */
    static boolean isNewer(String remote, String local) {
        int[] r = parse(remote), l = parse(local);
        for (int i = 0; i < Math.max(r.length, l.length); i++) {
            int a = i < r.length ? r[i] : 0, b = i < l.length ? l[i] : 0;
            if (a != b) return a > b;
        }
        return false;
    }

    private static int[] parse(String v) {
        if (v == null) return new int[0];
        String core = v.trim().replaceFirst("^[vV]", "").split("[-+ ]")[0];
        if (core.isEmpty()) return new int[0];
        String[] parts = core.split("\\.");
        int[] out = new int[parts.length];
        for (int i = 0; i < parts.length; i++) {
            try {
                out[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException e) {
                return new int[0]; // not a version we understand: treat as "nothing newer"
            }
        }
        return out;
    }

    @SuppressWarnings("deprecation")
    private static boolean isNewerBuildOfThisApp(Context ctx, File apk) {
        PackageInfo archive = ctx.getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
        if (archive == null || !ctx.getPackageName().equals(archive.packageName)) return false;
        try {
            PackageInfo installed = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long have = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? installed.getLongVersionCode() : installed.versionCode;
            long got = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                    ? archive.getLongVersionCode() : archive.versionCode;
            return got > have;
        } catch (Exception e) {
            return false;
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(TIMEOUT_MS);
        c.setReadTimeout(TIMEOUT_MS);
        c.setRequestProperty("User-Agent", "SimpleFramexWrapper-Updater");
        return c;
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
