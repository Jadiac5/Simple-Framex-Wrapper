package xyz.framextv.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Thin Android TV shell around https://framextv.xyz.
 *
 * The site has no remote-control support of its own, so the real work happens in
 * assets/tvnav.js, which is injected into every page and drives focus with the D-pad.
 * This class provides the WebView, fullscreen video, Back handling, a few TV-only
 * conveniences (options menu, media keys, on-screen keyboard) and keeps the app on the site.
 */
public class MainActivity extends Activity {

    private static final String TAG = "frameXTV";
    private static final String HOME_URL = "https://framextv.xyz/";
    private static final String ERROR_URL = "file:///android_asset/error.html";
    private static final String[] SITE_DOMAINS = {"framextv.xyz", "framextv.tech"};
    private static final String PREFS = "frameXTV";
    private static final String PREF_ZOOM = "zoom";
    private static final float[] ZOOM_LEVELS = {0.75f, 0.9f, 1f, 1.1f, 1.25f, 1.5f};
    private static final long DOUBLE_BACK_MS = 2000;

    private final Handler handler = new Handler(Looper.getMainLooper());

    private FrameLayout root;
    private WebView webView;
    private FrameLayout fullscreenHost;
    private View splash;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private AlertDialog optionsDialog;

    private androidx.webkit.ScriptHandler documentStartHandler;
    private boolean useDocumentStart;
    private String navScript = "";
    private float zoom = 1f;
    private boolean debuggable;
    private long lastBackAt;

    private static final long UPDATE_CHECK_MAX_MS = 4000;
    private boolean siteStarted;
    private View updateView;
    private Button updateButton;
    private Button updateSkip;
    private ProgressBar updateProgress;
    private TextView updateStatus;
    private Updater.Release updateRelease;
    private boolean updateDownloading;
    private boolean updateCancelled;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        debuggable = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) WebView.setWebContentsDebuggingEnabled(true);
        zoom = getSharedPreferences(PREFS, MODE_PRIVATE).getFloat(PREF_ZOOM, 1f);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        fullscreenHost = new FrameLayout(this);
        fullscreenHost.setBackgroundColor(Color.BLACK);
        fullscreenHost.setVisibility(View.GONE);
        root.addView(fullscreenHost, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        ProgressBar spinner = new ProgressBar(this);
        FrameLayout splashLayout = new FrameLayout(this);
        splashLayout.setBackgroundColor(Color.BLACK);
        splashLayout.addView(spinner, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        splash = splashLayout;
        root.addView(splash, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);

        configureSettings();
        configureNavigationScript();
        webView.setWebViewClient(new SiteClient());
        webView.setWebChromeClient(new SiteChromeClient());

        if (savedInstanceState != null) {
            // Recreated (e.g. renderer crash). If we were still in the startup check there is no page to restore.
            if (webView.restoreState(savedInstanceState) != null) {
                siteStarted = true;
                webView.requestFocus();
            } else {
                startSite();
            }
        } else {
            checkForUpdateThenStart();
        }
    }

    // ---------------------------------------------------------------- startup update check

    /** Loads the site, unless a newer GitHub release exists: then the update screen comes first. */
    private void checkForUpdateThenStart() {
        // Never hold the user up for long: if GitHub is slow the site just opens.
        handler.postDelayed(this::startSite, UPDATE_CHECK_MAX_MS);
        new Thread(() -> {
            final Updater.Release r = Updater.checkForUpdate(this, currentVersion());
            handler.post(() -> {
                if (isDestroyed()) return;
                if (r != null && !siteStarted && !isFinishing()) {
                    showUpdateScreen(r);
                } else {
                    startSite();
                }
            });
        }, "update-check").start();
    }

    private String currentVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "0";
        }
    }

    private void startSite() {
        if (siteStarted || updateView != null) return;
        siteStarted = true;
        webView.loadUrl(HOME_URL);
        webView.requestFocus();
    }

    private void showUpdateScreen(Updater.Release r) {
        updateRelease = r;
        float d = getResources().getDisplayMetrics().density;

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.BLACK);
        box.setClickable(true);

        TextView title = new TextView(this);
        title.setText(R.string.update_title);
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 34);
        title.setGravity(Gravity.CENTER);
        box.addView(title);

        TextView msg = new TextView(this);
        msg.setText(getString(R.string.update_message, r.version, currentVersion()));
        msg.setTextColor(0xFFBBBBBB);
        msg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        msg.setGravity(Gravity.CENTER);
        msg.setPadding(0, (int) (12 * d), 0, (int) (24 * d));
        box.addView(msg);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.CENTER);
        updateButton = makeButton(getString(R.string.update_button));
        updateSkip = makeButton(getString(R.string.update_skip));
        updateButton.setOnClickListener(v -> startUpdate());
        updateSkip.setOnClickListener(v -> dismissUpdateScreen());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                (int) (220 * d), ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins((int) (10 * d), 0, (int) (10 * d), 0);
        buttons.addView(updateSkip, lp);
        buttons.addView(updateButton, lp);
        box.addView(buttons);

        updateProgress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        updateProgress.setMax(100);
        updateProgress.setVisibility(View.GONE);
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams((int) (460 * d), (int) (12 * d));
        pp.topMargin = (int) (28 * d);
        box.addView(updateProgress, pp);

        updateStatus = new TextView(this);
        updateStatus.setTextColor(0xFFBBBBBB);
        updateStatus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        updateStatus.setGravity(Gravity.CENTER);
        updateStatus.setPadding((int) (40 * d), (int) (16 * d), (int) (40 * d), 0);
        box.addView(updateStatus);

        updateView = box;
        root.addView(box, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        splash.setVisibility(View.GONE);
        // "Go to website" is the default so a stray OK press can never start an install.
        updateSkip.requestFocus();
    }

    private Button makeButton(String text) {
        float d = getResources().getDisplayMetrics().density;
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        b.setTextColor(Color.WHITE);
        b.setFocusable(true);
        b.setPadding((int) (16 * d), (int) (14 * d), (int) (16 * d), (int) (14 * d));
        android.graphics.drawable.StateListDrawable bg = new android.graphics.drawable.StateListDrawable();
        bg.addState(new int[]{android.R.attr.state_focused}, buttonShape(0xFF22C55E, 0xFFFFFFFF, d));
        bg.addState(new int[]{}, buttonShape(0xFF2A2A2A, 0xFF555555, d));
        b.setBackground(bg);
        return b;
    }

    private static android.graphics.drawable.GradientDrawable buttonShape(int fill, int stroke, float d) {
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable();
        g.setColor(fill);
        g.setCornerRadius(10 * d);
        g.setStroke((int) (3 * d), stroke);
        return g;
    }

    private void dismissUpdateScreen() {
        if (updateView == null) return;
        updateCancelled = true;
        root.removeView(updateView);
        updateView = null;
        startSite();
    }

    private void setUpdateStatus(String text) {
        if (updateStatus != null) updateStatus.setText(text);
    }

    private void startUpdate() {
        if (updateDownloading || updateRelease == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            setUpdateStatus(getString(R.string.update_permission));
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getPackageName())));
            } catch (ActivityNotFoundException e) {
                setUpdateStatus(getString(R.string.update_permission_missing));
            }
            return;
        }
        updateDownloading = true;
        updateCancelled = false;
        updateButton.setEnabled(false);
        updateProgress.setProgress(0);
        updateProgress.setVisibility(View.VISIBLE);
        setUpdateStatus(getString(R.string.update_downloading, 0));
        final Updater.Release r = updateRelease;
        new Thread(() -> {
            try {
                final java.io.File apk = Updater.download(this, r, (done, total) -> {
                    final int pct = total > 0 ? (int) (done * 100 / total) : 0;
                    handler.post(() -> {
                        updateProgress.setProgress(pct);
                        setUpdateStatus(getString(R.string.update_downloading, pct));
                    });
                }, () -> updateCancelled);
                handler.post(() -> {
                    updateDownloading = false;
                    if (updateView == null) return;
                    try {
                        startActivity(Updater.installIntent(this, apk));
                        updateButton.setEnabled(true);
                        updateProgress.setVisibility(View.GONE);
                        setUpdateStatus("");
                    } catch (RuntimeException e) {
                        updateFailed();
                    }
                });
            } catch (Exception e) {
                Log.w(TAG, "Update failed", e);
                handler.post(() -> {
                    updateDownloading = false;
                    if (updateView != null) updateFailed();
                });
            }
        }, "update-download").start();
    }

    private void updateFailed() {
        updateButton.setEnabled(true);
        updateProgress.setVisibility(View.GONE);
        setUpdateStatus(getString(R.string.update_failed));
        updateSkip.requestFocus();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureSettings() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowContentAccess(false);
        s.setAllowFileAccess(false); // file:///android_asset/ stays reachable
        // Some embeds refuse to play in WebViews, so look like regular Chrome.
        String ua = s.getUserAgentString();
        if (ua != null) {
            s.setUserAgentString(ua.replace("; wv)", ")").replace(" Version/4.0", ""));
        }

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);
    }

    // ---------------------------------------------------------------- injected script

    private void configureNavigationScript() {
        try {
            navScript = buildScript();
        } catch (IOException e) {
            Log.e(TAG, "Could not read tvnav.js", e);
            return;
        }

        Set<String> origins = new HashSet<>();
        for (String d : SITE_DOMAINS) {
            origins.add("https://" + d);
            origins.add("https://*." + d);
        }

        boolean bridgeOk = false;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            try {
                WebViewCompat.addWebMessageListener(webView, "FxTV", origins,
                        (view, message, sourceOrigin, isMainFrame, replyProxy) ->
                                handleBridge(message.getData(), isMainFrame));
                bridgeOk = true;
            } catch (RuntimeException e) {
                Log.w(TAG, "WebMessageListener unavailable", e);
            }
        }
        if (!bridgeOk) {
            webView.addJavascriptInterface(new LegacyBridge(), "FxTV");
        }

        useDocumentStart = false;
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            try {
                documentStartHandler = WebViewCompat.addDocumentStartJavaScript(webView, navScript, origins);
                useDocumentStart = true;
            } catch (RuntimeException e) {
                Log.w(TAG, "Document-start script unavailable", e);
            }
        }
        Log.i(TAG, "bridge=" + (bridgeOk ? "web-message-listener" : "legacy")
                + " documentStart=" + useDocumentStart);
    }

    private String buildScript() throws IOException {
        StringBuilder cfg = new StringBuilder("window.__FXTV_CFG={zoom:")
                .append(String.format(Locale.US, "%.2f", zoom))
                .append(",debug:").append(debuggable).append("};\n");
        return cfg + readAsset("tvnav.js");
    }

    private String readAsset(String name) throws IOException {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    // ---------------------------------------------------------------- JS -> native

    /** Fallback bridge for WebViews that cannot do origin-restricted message listeners. */
    private class LegacyBridge {
        @JavascriptInterface
        public void postMessage(final String message) {
            handler.post(() -> {
                String url = webView.getUrl();
                if (isSiteUrl(url == null ? null : Uri.parse(url))) handleBridge(message, true);
            });
        }
    }

    private void handleBridge(String json, boolean isMainFrame) {
        try {
            JSONObject msg = new JSONObject(json);
            switch (msg.optString("t")) {
                case "tap":
                    if (isMainFrame) injectTap((float) msg.optDouble("x"), (float) msg.optDouble("y"));
                    break;
                case "ime":
                    showKeyboard();
                    break;
                case "hideime":
                    hideKeyboard();
                    break;
                case "menu":
                    showOptions();
                    break;
                default:
                    break;
            }
        } catch (Exception e) {
            Log.w(TAG, "Bad bridge message: " + json, e);
        }
    }

    /**
     * Cross-origin iframes (backup players) never see our script, so the page asks for a real
     * touch at a point (as a fraction of the viewport). That also hands keyboard focus to the frame.
     */
    private void injectTap(float fx, float fy) {
        final float x = Math.max(1, Math.min(webView.getWidth() - 1, fx * webView.getWidth()));
        final float y = Math.max(1, Math.min(webView.getHeight() - 1, fy * webView.getHeight()));
        final long down = SystemClock.uptimeMillis();
        MotionEvent d = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0);
        d.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        webView.dispatchTouchEvent(d);
        d.recycle();
        handler.postDelayed(() -> {
            MotionEvent u = MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0);
            u.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            webView.dispatchTouchEvent(u);
            u.recycle();
        }, 60);
    }

    private void showKeyboard() {
        handler.postDelayed(() -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) {
                // WebView.requestFocus() outside touch mode also moves the page's DOM focus to its first node, which
                // would pull the cursor out of the very field the keyboard is for.
                if (!webView.hasFocus()) webView.requestFocus();
                imm.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT);
            }
        }, 80);
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(webView.getWindowToken(), 0);
    }

    // ---------------------------------------------------------------- navigation policy

    private static boolean isSiteUrl(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if (!"https".equals(scheme) && !"http".equals(scheme)) return false;
        String host = uri.getHost();
        if (host == null) return false;
        host = host.toLowerCase(Locale.US);
        for (String d : SITE_DOMAINS) {
            if (host.equals(d) || host.endsWith("." + d)) return true;
        }
        return false;
    }

    private static boolean isErrorPage(Uri uri) {
        return uri != null && "file".equals(uri.getScheme())
                && "/android_asset/error.html".equals(uri.getPath());
    }

    private class SiteClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (!request.isForMainFrame()) return false;
            Uri uri = request.getUrl();
            if (isSiteUrl(uri) || isErrorPage(uri) || "about".equals(uri.getScheme())) return false;
            // Ad scripts and "open in new tab" links would otherwise take over the whole screen.
            Log.i(TAG, "Blocked navigation to " + uri);
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            splash.setVisibility(View.GONE);
            if (!useDocumentStart && isSiteUrl(url == null ? null : Uri.parse(url))) {
                view.evaluateJavascript(navScript, null);
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            Uri uri = request.getUrl();
            if (isErrorPage(uri)) return;
            CharSequence desc = error.getDescription();
            if (desc != null && desc.toString().contains("ERR_ABORTED")) return;
            splash.setVisibility(View.GONE);
            view.loadUrl(ERROR_URL + "?u=" + Uri.encode(uri.toString())
                    + "&d=" + Uri.encode(desc == null ? "" : desc.toString()));
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.w(TAG, "WebView renderer gone (crash=" + detail.didCrash() + "), restarting");
            handler.post(MainActivity.this::recreate);
            return true;
        }
    }

    private class SiteChromeClient extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customViewCallback = callback;
            fullscreenHost.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            fullscreenHost.setVisibility(View.VISIBLE);
            // Key events only reach the page if Android focus lands on Chromium's content view
            // inside the custom view, not on the wrapper around it (a tap does exactly that).
            if (view instanceof ViewGroup) {
                ((ViewGroup) view).setDescendantFocusability(ViewGroup.FOCUS_AFTER_DESCENDANTS);
            }
            view.requestFocus();
            handler.postDelayed(() -> {
                if (customView == view && !view.hasFocus()) view.requestFocus();
            }, 150);
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) return;
            fullscreenHost.removeView(customView);
            fullscreenHost.setVisibility(View.GONE);
            customView = null;
            if (customViewCallback != null) customViewCallback.onCustomViewHidden();
            customViewCallback = null;
            webView.requestFocus();
        }

        @Override
        public Bitmap getDefaultVideoPoster() {
            // The stock poster is a grey play glyph that flashes before every video.
            return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
        }

        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            if (debuggable) Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
            return true;
        }
    }

    // ---------------------------------------------------------------- keys & Back

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        boolean up = event.getAction() == KeyEvent.ACTION_UP;

        switch (code) {
            case KeyEvent.KEYCODE_BACK:
                if (up && !event.isCanceled()) handleBack();
                return true;

            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_INFO:
            case KeyEvent.KEYCODE_SETTINGS:
            case KeyEvent.KEYCODE_TV_CONTENTS_MENU:
            case KeyEvent.KEYCODE_TV_MEDIA_CONTEXT_MENU:
                if (up) showOptions();
                return true;

            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_STOP:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                if (down && event.getRepeatCount() == 0) mediaKey(code);
                return true;

            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
            case KeyEvent.KEYCODE_BUTTON_A:
                // Make sure the page sees a plain Enter whatever the remote sends for OK.
                return super.dispatchKeyEvent(new KeyEvent(event.getDownTime(), event.getEventTime(),
                        event.getAction(), KeyEvent.KEYCODE_ENTER, event.getRepeatCount(),
                        event.getMetaState(), event.getDeviceId(), event.getScanCode(),
                        event.getFlags(), event.getSource()));

            default:
                return super.dispatchKeyEvent(event);
        }
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void handleBack() {
        if (updateView != null) {
            // Back on the update screen: cancel a running download, otherwise skip to the site.
            if (updateDownloading) updateCancelled = true;
            else dismissUpdateScreen();
            return;
        }
        // The page knows best what Back should undo (menus, controls, fullscreen, text entry...).
        webView.evaluateJavascript(
                "(function(){try{return !!(window.__fxtvBack&&window.__fxtvBack())}catch(e){return false}})()",
                value -> {
                    if ("true".equals(value)) return;
                    if (customView != null) {
                        webView.getWebChromeClient().onHideCustomView();
                    } else if (webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        long now = SystemClock.uptimeMillis();
                        if (now - lastBackAt < DOUBLE_BACK_MS) {
                            finish();
                        } else {
                            lastBackAt = now;
                            Toast.makeText(this, R.string.press_back_again, Toast.LENGTH_SHORT).show();
                        }
                    }
                });
    }

    private void mediaKey(int code) {
        String action;
        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY: action = "play"; break;
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_STOP: action = "pause"; break;
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: action = "forward"; break;
            case KeyEvent.KEYCODE_MEDIA_REWIND: action = "rewind"; break;
            default: action = "toggle"; break;
        }
        webView.evaluateJavascript("window.__fxtvMedia&&window.__fxtvMedia('" + action + "')", null);
    }

    // ---------------------------------------------------------------- options menu

    private void showOptions() {
        if (optionsDialog != null && optionsDialog.isShowing()) return;
        final CharSequence[] items = {
                getString(R.string.opt_reload),
                getString(R.string.opt_home),
                getString(R.string.opt_page_size, Math.round(zoom * 100)),
                getString(R.string.opt_clear_cache),
                getString(R.string.opt_exit),
        };
        optionsDialog = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle(R.string.app_name)
                .setItems(items, (dialog, which) -> {
                    switch (which) {
                        case 0: webView.reload(); break;
                        case 1: webView.loadUrl(HOME_URL); break;
                        case 2: handler.post(this::showPageSizeChooser); break;
                        case 3:
                            webView.clearCache(true);
                            webView.reload();
                            Toast.makeText(this, R.string.cache_cleared, Toast.LENGTH_SHORT).show();
                            break;
                        default: finish(); break;
                    }
                })
                .setOnDismissListener(d -> webView.requestFocus())
                .create();
        optionsDialog.show();
    }

    private void showPageSizeChooser() {
        CharSequence[] labels = new CharSequence[ZOOM_LEVELS.length];
        int checked = 0;
        for (int i = 0; i < ZOOM_LEVELS.length; i++) {
            labels[i] = Math.round(ZOOM_LEVELS[i] * 100) + "%" + (ZOOM_LEVELS[i] == 1f ? "  (default)" : "");
            if (Math.abs(ZOOM_LEVELS[i] - zoom) < 0.01f) checked = i;
        }
        optionsDialog = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle(R.string.page_size_title)
                .setSingleChoiceItems(labels, checked, (dialog, which) -> {
                    dialog.dismiss();
                    applyZoom(ZOOM_LEVELS[which]);
                })
                .setOnDismissListener(d -> webView.requestFocus())
                .create();
        optionsDialog.show();
    }

    private void applyZoom(float newZoom) {
        if (Math.abs(newZoom - zoom) < 0.01f) return;
        zoom = newZoom;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putFloat(PREF_ZOOM, zoom).apply();
        try {
            navScript = buildScript();
            if (useDocumentStart && documentStartHandler != null) {
                documentStartHandler.remove();
                Set<String> origins = new HashSet<>();
                for (String d : SITE_DOMAINS) {
                    origins.add("https://" + d);
                    origins.add("https://*." + d);
                }
                documentStartHandler = WebViewCompat.addDocumentStartJavaScript(webView, navScript, origins);
            }
        } catch (IOException e) {
            Log.e(TAG, "Could not rebuild script", e);
        }
        webView.reload();
    }

    // ---------------------------------------------------------------- lifecycle

    private void enterImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive();
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        // Pressing Home must not leave the show playing in the background.
        webView.evaluateJavascript(
                "(function(){var v=document.getElementsByTagName('video');for(var i=0;i<v.length;i++)v[i].pause()})()",
                null);
        webView.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        if (updateView == null) webView.requestFocus();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        updateCancelled = true;
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
        }
        super.onDestroy();
    }
}
