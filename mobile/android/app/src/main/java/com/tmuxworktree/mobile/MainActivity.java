package com.tmuxworktree.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.text.method.PasswordTransformationMethod;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.BaseAdapter;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

public class MainActivity extends Activity {
    private static final String TAG = "TwMobile";
    private static final int MAX_RECONNECT_DELAY_MS = 15_000;
    private static final String PREFS_IDENTITY = "identity";

    // Palette
    static final int BG            = Color.rgb(7, 10, 14);
    static final int SURFACE       = Color.rgb(18, 22, 29);
    static final int SURFACE_2     = Color.rgb(25, 30, 39);
    static final int BORDER        = Color.rgb(44, 52, 64);
    static final int TEXT_PRIMARY  = Color.rgb(237, 241, 245);
    static final int TEXT_SECOND   = Color.rgb(164, 172, 184);
    static final int TEXT_MUTED    = Color.rgb(103, 112, 126);
    static final int ACCENT        = Color.rgb(183, 148, 246);
    static final int ACCENT_2      = Color.rgb(246, 135, 179);
    static final int ACCENT_PRESS  = Color.rgb(139, 103, 210);
    static final int SUCCESS       = Color.rgb(103, 213, 132);
    static final int ERROR_C       = Color.rgb(247, 96, 96);
    static final int WARNING       = Color.rgb(242, 178, 73);
    static final int TERM_BG       = Color.rgb(2, 5, 9);
    static final int TERM_TEXT     = Color.rgb(213, 218, 226);
    static final int ROW_SELECT    = Color.rgb(20, 48, 67);

    // Protocol state
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final OkHttpClient httpClient = new OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build();
    private final List<RelayHost> hosts = new ArrayList<>();
    private final List<RelaySession> sessions = new ArrayList<>();
    private final List<RelayScopeStatus> scopeStatuses = new ArrayList<>();
    private final List<String> pendingTerminalWrites = new ArrayList<>();
    private final StringBuilder terminalDataBuffer = new StringBuilder();
    private final Map<String, RelayHost> sessionRequests = new HashMap<>();
    private final Map<String, RelaySession> killRequests = new HashMap<>();

    private WebSocket webSocket;
    private WebSocket ignoredSocket;
    private String activeStreamId;
    private String selectedHostId = "";
    private String selectedSession = "";
    private String pendingAutoHostId;
    private String pendingAutoOpenSession;
    private String pendingAutoCommand;
    private String latestSessionsRequestId = "";

    // View references
    private TextView statusDot;
    private TextView statusText;
    private TextView toolbarTitle;
    private TextView backButton;
    private TextView identityToggleButton;
    private TextView refreshButton;
    private LinearLayout appBarView;
    private View tabBarView;
    private View tabDividerView;
    private View identityCardView;
    private View devicesCardView;
    private EditText relayInput;
    private EditText tokenInput;
    private TextView selectedHostBadge;
    private TextView selectedSessionBadge;
    private TextView remoteStatusText;
    private TextView consoleHostChip;
    private TextView consoleSessionChip;
    private TextView openButton;
    private View contextBarView;
    private WebView terminalWebView;
    private EditText messageInput;
    private FrameLayout terminalFrame;
    private LinearLayout composerPanel;
    private LinearLayout shortcutBar;
    private TextView shortcutCollapsedButton;
    private HostAdapter hostAdapter;
    private SessionAdapter sessionAdapter;
    private SessionAdapter terminalAdapter;
    private ListView hostList;
    private ListView sessionList;
    private ListView terminalList;
    private LinearLayout dashboardList;

    // Tab content
    private View connectTabContent;
    private View consoleTabContent;
    private TextView tabConnect;
    private TextView tabConsole;
    private View tabIndicatorConnect;
    private View tabIndicatorConsole;

    // Connection state for UI
    private boolean isConnected = false;
    private boolean terminalReady = false;
    private boolean terminalMode = false;
    private boolean composerVisible = false;
    private boolean shortcutsCollapsed = false;
    private boolean identityExpanded = true;
    private boolean userDisconnectRequested = true;
    private boolean reconnectScheduled = false;
    private boolean savedAutoConnect = false;
    private boolean terminalFlushScheduled = false;
    private boolean terminalStreamReopenScheduled = false;
    private int reconnectAttempt = 0;
    private long lastRefreshAt = 0;
    private int lastVisibleRootHeight = 0;
    private boolean keyboardVisible = false;
    private Runnable reconnectRunnable;

    // Lifecycle

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(BG);
        getWindow().setNavigationBarColor(BG);
        pendingAutoHostId = getIntent().getStringExtra("hostId");
        pendingAutoOpenSession = getIntent().getStringExtra("autoOpenSession");
        pendingAutoCommand = getIntent().getStringExtra("autoCommand");
        buildUi();
        loadSavedIdentity();
        boolean canAutoConnect = (getIntent().getBooleanExtra("autoConnect", false) || savedAutoConnect)
            && relayInput.getText().length() > 0
            && tokenInput.getText().length() > 0;
        if (canAutoConnect) {
            setIdentityExpanded(false);
            relayInput.postDelayed(this::connect, 500);
        } else {
            setIdentityExpanded(true);
            relayInput.postDelayed(this::showIdentityDialog, 250);
        }
    }

    @Override
    protected void onDestroy() {
        userDisconnectRequested = true;
        cancelReconnect();
        disconnect();
        httpClient.dispatcher().executorService().shutdown();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (terminalMode) {
            if (composerVisible || (messageInput != null && messageInput.hasFocus())) {
                composerVisible = false;
                if (composerPanel != null) composerPanel.setVisibility(View.GONE);
                hideKeyboard();
                return;
            }
            hideKeyboard();
            exitTerminalMode();
            return;
        }
        super.onBackPressed();
    }

    // UI Construction

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(BG);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
            requestTerminalFitBurst();
            return insets;
        });
        setContentView(root);
        installViewportChangeWatcher(root);

        buildAppBar(root);
        buildTabBar(root);
        buildTabContent(root);
        if (tabBarView != null) tabBarView.setVisibility(View.GONE);
        if (tabDividerView != null) tabDividerView.setVisibility(View.GONE);
    }

    private void installViewportChangeWatcher(View root) {
        root.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
            Rect visibleFrame = new Rect();
            root.getWindowVisibleDisplayFrame(visibleFrame);
            int visibleHeight = Math.max(0, visibleFrame.height());
            int rootHeight = Math.max(0, root.getRootView().getHeight());
            if (visibleHeight == lastVisibleRootHeight) return;
            lastVisibleRootHeight = visibleHeight;

            int hiddenHeight = Math.max(0, rootHeight - visibleHeight);
            boolean nextKeyboardVisible = hiddenHeight > Math.max(dp(120), rootHeight / 5);
            boolean keyboardClosed = keyboardVisible && !nextKeyboardVisible;
            keyboardVisible = nextKeyboardVisible;

            if (terminalMode) {
                if (keyboardClosed) {
                    if (composerVisible && composerPanel != null && composerPanel.getVisibility() == View.VISIBLE) {
                        composerVisible = false;
                        composerPanel.setVisibility(View.GONE);
                        if (messageInput != null) messageInput.clearFocus();
                        updateTerminalChromePadding();
                    }
                    if (terminalWebView != null) terminalWebView.requestFocus();
                }
                requestTerminalFitBurst();
            }
        });
    }

    private void buildAppBar(LinearLayout parent) {
        LinearLayout bar = new LinearLayout(this);
        appBarView = bar;
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(BG);
        bar.setPadding(dp(10), dp(4), dp(10), dp(4));
        parent.addView(bar, matchWrap());

        GradientDrawable barBg = new GradientDrawable();
        barBg.setColor(SURFACE);
        barBg.setStroke(0, 0);
        bar.setBackground(barBg);

        backButton = new TextView(this);
        backButton.setText("<");
        backButton.setTextSize(15);
        backButton.setTypeface(Typeface.DEFAULT_BOLD);
        backButton.setTextColor(TEXT_SECOND);
        backButton.setGravity(Gravity.CENTER);
        backButton.setPadding(dp(8), dp(3), dp(8), dp(3));
        backButton.setBackground(roundBg(SURFACE_2, dp(8), BORDER));
        backButton.setVisibility(View.GONE);
        backButton.setOnClickListener(v -> {
            hideKeyboard();
            exitTerminalMode();
        });
        LinearLayout.LayoutParams backLp = new LinearLayout.LayoutParams(dp(32), dp(30));
        backLp.setMargins(0, 0, dp(8), 0);
        bar.addView(backButton, backLp);

        statusDot = new TextView(this);
        statusDot.setText("●");
        statusDot.setTextSize(12);
        statusDot.setTextColor(ERROR_C);
        LinearLayout.LayoutParams dotLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        dotLp.setMargins(0, 0, dp(8), 0);
        bar.addView(statusDot, dotLp);

        toolbarTitle = new TextView(this);
        toolbarTitle.setText("tw-dashboard");
        toolbarTitle.setTextSize(15);
        toolbarTitle.setTypeface(Typeface.DEFAULT_BOLD);
        toolbarTitle.setTextColor(TEXT_PRIMARY);
        toolbarTitle.setSingleLine(true);
        toolbarTitle.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        bar.addView(toolbarTitle, titleLp);

        identityToggleButton = new TextView(this);
        identityToggleButton.setText("ID");
        identityToggleButton.setTextSize(12);
        identityToggleButton.setTypeface(Typeface.DEFAULT_BOLD);
        identityToggleButton.setTextColor(ACCENT);
        identityToggleButton.setGravity(Gravity.CENTER);
        identityToggleButton.setPadding(dp(7), dp(3), dp(7), dp(3));
        identityToggleButton.setBackground(roundBg(SURFACE_2, dp(8), BORDER));
        identityToggleButton.setOnClickListener(v -> setIdentityExpanded(!identityExpanded));
        LinearLayout.LayoutParams identityLp = new LinearLayout.LayoutParams(dp(34), dp(30));
        identityLp.setMargins(dp(6), 0, 0, 0);
        bar.addView(identityToggleButton, identityLp);

        refreshButton = new TextView(this);
        refreshButton.setText("↻");
        refreshButton.setTextSize(15);
        refreshButton.setTypeface(Typeface.DEFAULT_BOLD);
        refreshButton.setTextColor(TEXT_SECOND);
        refreshButton.setGravity(Gravity.CENTER);
        refreshButton.setPadding(dp(7), dp(3), dp(7), dp(3));
        refreshButton.setBackground(roundBg(SURFACE_2, dp(8), BORDER));
        refreshButton.setOnClickListener(v -> refreshDashboard());
        LinearLayout.LayoutParams refreshLp = new LinearLayout.LayoutParams(dp(30), dp(30));
        refreshLp.setMargins(dp(6), 0, dp(6), 0);
        bar.addView(refreshButton, refreshLp);

        // Status text
        statusText = new TextView(this);
        statusText.setText("Disconnected");
        statusText.setTextSize(12);
        statusText.setTextColor(TEXT_SECOND);
        statusText.setGravity(Gravity.END);
        statusText.setMaxLines(1);
        statusText.setSingleLine(true);
        statusText.setEllipsize(TextUtils.TruncateAt.END);
        statusText.setMaxWidth(dp(150));
        bar.addView(statusText, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
    }

    private void buildTabBar(LinearLayout parent) {
        LinearLayout tabBar = new LinearLayout(this);
        tabBarView = tabBar;
        tabBar.setOrientation(LinearLayout.HORIZONTAL);
        tabBar.setBackgroundColor(BG);
        tabBar.setPadding(dp(12), 0, dp(12), 0);
        parent.addView(tabBar, matchWrap());

        tabConnect = makeTab("Connect", true);
        tabConsole = makeTab("Console", false);

        LinearLayout.LayoutParams tabLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);

        // Wrap each tab in a vertical layout for the indicator
        LinearLayout connectWrap = tabWithIndicator(tabConnect, true);
        LinearLayout consoleWrap = tabWithIndicator(tabConsole, false);
        tabIndicatorConnect = (View) connectWrap.getTag();
        tabIndicatorConsole = (View) consoleWrap.getTag();

        tabBar.addView(connectWrap, tabLp);
        tabBar.addView(consoleWrap, tabLp);

        tabConnect.setOnClickListener(v -> selectTab(0));
        tabConsole.setOnClickListener(v -> selectTab(1));

        // Divider
        View divider = new View(this);
        tabDividerView = divider;
        divider.setBackgroundColor(BORDER);
        parent.addView(divider, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(1)));
    }

    private LinearLayout tabWithIndicator(TextView tab, boolean selected) {
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setPadding(0, dp(2), 0, 0);

        tab.setGravity(Gravity.CENTER);
        tab.setPadding(dp(12), dp(1), dp(12), dp(5));
        wrap.addView(tab, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        View indicator = new View(this);
        indicator.setBackgroundColor(selected ? ACCENT : Color.TRANSPARENT);
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(2));
        wrap.addView(indicator, ilp);
        wrap.setTag(indicator);
        return wrap;
    }

    private TextView makeTab(String text, boolean selected) {
        TextView tab = new TextView(this);
        tab.setText(text);
        tab.setTextSize(12);
        tab.setTypeface(Typeface.DEFAULT_BOLD);
        tab.setTextColor(selected ? ACCENT : TEXT_MUTED);
        return tab;
    }

    private void selectTab(int index) {
        boolean isConnect = index == 0;
        tabConnect.setTextColor(isConnect ? ACCENT : TEXT_MUTED);
        tabConsole.setTextColor(!isConnect ? ACCENT : TEXT_MUTED);
        tabIndicatorConnect.setBackgroundColor(isConnect ? ACCENT : Color.TRANSPARENT);
        tabIndicatorConsole.setBackgroundColor(!isConnect ? ACCENT : Color.TRANSPARENT);
        connectTabContent.setVisibility(isConnect ? View.VISIBLE : View.GONE);
        consoleTabContent.setVisibility(!isConnect ? View.VISIBLE : View.GONE);
    }

    private void setIdentityExpanded(boolean expanded) {
        identityExpanded = expanded;
        if (identityCardView != null) {
            identityCardView.setVisibility(expanded ? View.VISIBLE : View.GONE);
        }
        if (identityToggleButton != null) {
            identityToggleButton.setTextColor(expanded ? ACCENT : TEXT_SECOND);
            identityToggleButton.setBackground(roundBg(expanded ? Color.rgb(34, 44, 62) : SURFACE_2, dp(8), BORDER));
        }
    }

    private void buildTabContent(LinearLayout parent) {
        // Use a FrameLayout-like approach: both children in the same space, one visible at a time
        LinearLayout contentArea = new LinearLayout(this);
        contentArea.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1);
        parent.addView(contentArea, clp);

        // Connect tab content
        connectTabContent = buildConnectContent();
        contentArea.addView(connectTabContent, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

        // Console tab content
        consoleTabContent = buildConsoleContent();
        contentArea.addView(consoleTabContent, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT));

        // Start on connect tab
        consoleTabContent.setVisibility(View.GONE);
    }

    // Connect tab

    private View buildConnectContent() {
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setBackgroundColor(BG);
        content.setPadding(dp(6), dp(5), dp(6), dp(6));

        // Identity card
        LinearLayout identityCard = card(content, "Identity");
        identityCardView = identityCard;
        identityCard.setVisibility(identityExpanded ? View.VISIBLE : View.GONE);

        // Relay URL field
        TextView relayLabel = smallLabel("Relay URL");
        identityCard.addView(relayLabel, matchWrap());

        relayInput = styledField(
            getIntent().getStringExtra("relayUrl"),
            "wss://relay.example.com",
            "wss://relay.example.com",
            false
        );
        installIdentityEditStopper(relayInput);
        identityCard.addView(relayInput, matchWrapMargin(0, 2, 0, 10));

        // Token field
        TextView tokenLabel = smallLabel("Identity Token");
        identityCard.addView(tokenLabel, matchWrap());

        tokenInput = styledField(
            getIntent().getStringExtra("relaySecret"),
            "",
            "bearer token",
            true
        );
        installIdentityEditStopper(tokenInput);
        identityCard.addView(tokenInput, matchWrapMargin(0, 2, 0, 12));

        // Action buttons
        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        identityCard.addView(btnRow, matchWrap());

        TextView btnConnect = primaryButton("Connect");
        btnConnect.setOnClickListener(v -> connect());
        btnRow.addView(btnConnect, weightLp(1, 0, 0, 6, 0));

        TextView btnStop = secondaryButton("Stop");
        btnStop.setOnClickListener(v -> {
            disconnectAndForget();
            setStatusUi("Disconnected", ERROR_C);
        });
        btnRow.addView(btnStop, weightLp(1, 6, 0, 6, 0));

        TextView btnClear = dangerButton("Clear");
        btnClear.setOnClickListener(v -> {
            disconnectAndForget();
            clearSavedIdentity();
            setStatusUi("Connection cleared", WARNING);
        });
        btnRow.addView(btnClear, weightLp(1, 6, 0, 0, 0));

        // Devices card
        LinearLayout devicesCard = card(content, "Devices");
        devicesCardView = devicesCard;
        devicesCard.setVisibility(View.GONE);

        // Selected host badge
        selectedHostBadge = chipView("No device selected", TEXT_MUTED, SURFACE_2);
        selectedHostBadge.setVisibility(View.GONE);
        LinearLayout.LayoutParams badgeLp = matchWrapMargin(0, 0, 0, 8);
        devicesCard.addView(selectedHostBadge, badgeLp);

        hostList = new ListView(this);
        hostList.setDivider(null);
        hostList.setDividerHeight(0);
        hostList.setCacheColorHint(Color.TRANSPARENT);
        hostList.setBackgroundColor(SURFACE_2);
        GradientDrawable listBg = new GradientDrawable();
        listBg.setColor(SURFACE_2);
        listBg.setCornerRadius(dp(8));
        hostList.setBackground(listBg);
        hostAdapter = new HostAdapter();
        hostList.setAdapter(hostAdapter);
        hostList.setOnItemClickListener((parent, view, position, id) -> {
            RelayHost host = hosts.get(position);
            selectedHostId = host.hostId;
            selectedSession = "";
            savePreferredHost(selectedHostId);
            hostAdapter.notifyDataSetChanged();
            updateSelectedHostBadge();
            listSessions();
        });
        devicesCard.addView(hostList, fixedHeight(dp(96)));

        // Main dashboard section
        LinearLayout sessionsCard = section(content, "WorkTrees");
        LinearLayout.LayoutParams sessionsLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1
        );
        sessionsLp.setMargins(0, 0, 0, 0);
        sessionsCard.setLayoutParams(sessionsLp);

        selectedSessionBadge = chipView("No session selected", TEXT_MUTED, SURFACE_2);
        selectedSessionBadge.setVisibility(View.GONE);
        LinearLayout.LayoutParams sBadgeLp = matchWrapMargin(0, 0, 0, 4);
        sessionsCard.addView(selectedSessionBadge, sBadgeLp);

        LinearLayout createRow = new LinearLayout(this);
        createRow.setOrientation(LinearLayout.HORIZONTAL);
        createRow.setGravity(Gravity.CENTER_VERTICAL);
        sessionsCard.addView(createRow, matchWrapMargin(0, 0, 0, 4));

        remoteStatusText = inlineStatusView("Remotes: checking");
        remoteStatusText.setTextSize(11);
        createRow.addView(remoteStatusText, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        TextView newWorktreeButton = compactButton("+ WT");
        newWorktreeButton.setOnClickListener(v -> showCreateWorktreeDialog());
        LinearLayout.LayoutParams newWtLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        newWtLp.setMargins(dp(4), 0, 0, 0);
        createRow.addView(newWorktreeButton, newWtLp);

        TextView newTerminalButton = compactButton("+ Term");
        newTerminalButton.setOnClickListener(v -> showCreateTerminalDialog());
        LinearLayout.LayoutParams newTermLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        newTermLp.setMargins(dp(4), 0, 0, 0);
        createRow.addView(newTerminalButton, newTermLp);

        ScrollView dashboardScroll = new ScrollView(this);
        dashboardScroll.setFillViewport(false);
        dashboardScroll.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        dashboardScroll.setBackgroundColor(Color.TRANSPARENT);
        dashboardList = new LinearLayout(this);
        dashboardList.setOrientation(LinearLayout.VERTICAL);
        dashboardScroll.addView(dashboardList, new ScrollView.LayoutParams(
            ScrollView.LayoutParams.MATCH_PARENT,
            ScrollView.LayoutParams.WRAP_CONTENT
        ));
        sessionsCard.addView(dashboardScroll, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1
        ));
        renderSessionRows();

        return content;
    }

    // Console tab

    private View buildConsoleContent() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(BG);
        layout.setPadding(dp(10), dp(8), dp(10), dp(8));

        LinearLayout contextBar = new LinearLayout(this);
        contextBarView = contextBar;
        contextBar.setOrientation(LinearLayout.HORIZONTAL);
        contextBar.setGravity(Gravity.CENTER_VERTICAL);
        contextBar.setPadding(0, 0, 0, dp(6));
        layout.addView(contextBar, new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(40)
        ));

        HorizontalScrollView chipScroll = new HorizontalScrollView(this);
        chipScroll.setHorizontalScrollBarEnabled(false);
        chipScroll.setFillViewport(false);
        LinearLayout chipRow = new LinearLayout(this);
        chipRow.setOrientation(LinearLayout.HORIZONTAL);
        chipRow.setGravity(Gravity.CENTER_VERTICAL);
        chipScroll.addView(chipRow, new HorizontalScrollView.LayoutParams(
            HorizontalScrollView.LayoutParams.WRAP_CONTENT,
            HorizontalScrollView.LayoutParams.WRAP_CONTENT
        ));
        contextBar.addView(chipScroll, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        consoleHostChip = chipView("No device", TEXT_SECOND, SURFACE);
        consoleHostChip.setMaxWidth(dp(150));
        consoleHostChip.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams hcLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        hcLp.setMargins(0, 0, dp(6), 0);
        chipRow.addView(consoleHostChip, hcLp);

        consoleSessionChip = chipView("No session", TEXT_SECOND, SURFACE);
        consoleSessionChip.setMaxWidth(dp(220));
        consoleSessionChip.setEllipsize(TextUtils.TruncateAt.END);
        chipRow.addView(consoleSessionChip, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        openButton = secondaryButton("Open");
        openButton.setOnClickListener(v -> openSession());
        LinearLayout.LayoutParams openLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        openLp.setMargins(dp(6), 0, 0, 0);
        contextBar.addView(openButton, openLp);

        terminalFrame = new FrameLayout(this);
        terminalFrame.setBackgroundColor(TERM_BG);
        terminalFrame.addOnLayoutChangeListener((v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            if (terminalMode && (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop)) {
                requestTerminalFitBurst();
            }
        });
        LinearLayout.LayoutParams frameLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1);
        layout.addView(terminalFrame, frameLp);

        terminalWebView = new WebView(this);
        terminalWebView.setBackgroundColor(TERM_BG);
        terminalWebView.setWebChromeClient(new WebChromeClient());
        terminalWebView.addJavascriptInterface(new TerminalBridge(), "TwBridge");
        WebSettings settings = terminalWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        terminalFrame.addView(terminalWebView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        loadTerminalHtml();

        composerPanel = new LinearLayout(this);
        composerPanel.setOrientation(LinearLayout.HORIZONTAL);
        composerPanel.setGravity(Gravity.CENTER_VERTICAL);
        composerPanel.setPadding(dp(8), dp(6), dp(8), dp(6));
        GradientDrawable composerBg = new GradientDrawable();
        composerBg.setColor(Color.argb(232, 18, 22, 29));
        composerBg.setCornerRadius(dp(10));
        composerBg.setStroke(dp(1), BORDER);
        composerPanel.setBackground(composerBg);
        FrameLayout.LayoutParams composerLp = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM
        );
        composerLp.setMargins(dp(10), 0, dp(10), dp(60));
        terminalFrame.addView(composerPanel, composerLp);
        composerPanel.setVisibility(View.GONE);

        messageInput = new EditText(this);
        messageInput.setHint("Message to tmux agent");
        messageInput.setHintTextColor(TEXT_MUTED);
        messageInput.setTextColor(TEXT_PRIMARY);
        messageInput.setTextSize(13);
        messageInput.setBackgroundColor(Color.TRANSPARENT);
        messageInput.setSingleLine(false);
        messageInput.setMinLines(1);
        messageInput.setMaxLines(3);
        messageInput.setVerticalScrollBarEnabled(true);
        messageInput.setImeOptions(EditorInfo.IME_ACTION_SEND);
        messageInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        messageInput.setFocusableInTouchMode(true);
        messageInput.setOnClickListener(v -> focusMessageInput());
        messageInput.setOnTouchListener((v, event) -> {
            if (event.getAction() == MotionEvent.ACTION_DOWN) {
                focusMessageInput();
            }
            return false;
        });
        messageInput.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_SEND) {
                sendAgentMessage();
                return true;
            }
            return false;
        });
        composerPanel.addView(messageInput, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        TextView sendBtn = primaryButton("Send");
        sendBtn.setOnClickListener(v -> sendAgentMessage());
        LinearLayout.LayoutParams sendLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        sendLp.setMargins(dp(8), 0, 0, 0);
        composerPanel.addView(sendBtn, sendLp);

        shortcutBar = new LinearLayout(this);
        shortcutBar.setOrientation(LinearLayout.HORIZONTAL);
        shortcutBar.setGravity(Gravity.CENTER_VERTICAL);
        shortcutBar.setPadding(dp(6), dp(6), dp(6), dp(6));
        shortcutBar.setBackground(roundBg(Color.argb(220, 20, 22, 26), dp(12), BORDER));
        FrameLayout.LayoutParams shortcutLp = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL
        );
        shortcutLp.setMargins(0, 0, 0, dp(10));
        terminalFrame.addView(shortcutBar, shortcutLp);

        addShortcutBtn(shortcutBar, "Msg", "");
        addShortcutBtn(shortcutBar, "Esc", "");
        addShortcutBtn(shortcutBar, "Tab", "\t");
        addShortcutBtn(shortcutBar, "C-c", "");
        addShortcutBtn(shortcutBar, "Hide", "");

        shortcutCollapsedButton = secondaryButton("Tools");
        shortcutCollapsedButton.setTextSize(12);
        shortcutCollapsedButton.setOnClickListener(v -> setShortcutsCollapsed(false));
        FrameLayout.LayoutParams collapsedLp = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT,
            FrameLayout.LayoutParams.WRAP_CONTENT,
            Gravity.BOTTOM | Gravity.RIGHT
        );
        collapsedLp.setMargins(0, 0, dp(10), dp(10));
        terminalFrame.addView(shortcutCollapsedButton, collapsedLp);
        shortcutCollapsedButton.setVisibility(View.GONE);

        return layout;
    }

    // UI Helpers

    private int dp(int px) {
        float density = getResources().getDisplayMetrics().density;
        return Math.round(px * density);
    }

    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
    }

    private LinearLayout.LayoutParams matchWrapMargin(int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(l), dp(t), dp(r), dp(b));
        return lp;
    }

    private LinearLayout.LayoutParams fixedHeight(int h) {
        return new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, h);
    }

    private ListView makeSessionListView() {
        ListView list = new ListView(this);
        list.setDivider(null);
        list.setDividerHeight(0);
        list.setCacheColorHint(Color.TRANSPARENT);
        list.setBackgroundColor(Color.TRANSPARENT);
        list.setOverScrollMode(View.OVER_SCROLL_IF_CONTENT_SCROLLS);
        return list;
    }

    private void selectSessionAndOpen(RelaySession session) {
        selectedHostId = session.hostId;
        selectedSession = session.name;
        savePreferredHost(selectedHostId);
        updateSelectedHostBadge();
        notifySessionAdapters();
        updateSelectedSessionBadge();
        openSession();
        selectTab(1);
    }

    private void notifySessionAdapters() {
        if (sessionAdapter != null) sessionAdapter.notifyDataSetChanged();
        if (terminalAdapter != null) terminalAdapter.notifyDataSetChanged();
        renderSessionRows();
    }

    private void renderSessionRows() {
        if (dashboardList == null) return;
        dashboardList.removeAllViews();
        int terminals = 0;
        Map<String, List<RelaySession>> worktreeGroups = new LinkedHashMap<>();
        Map<String, String> worktreeGroupTitles = new LinkedHashMap<>();
        for (RelaySession session : sessions) {
            if ("terminal".equals(session.kind)) {
                terminals++;
            } else {
                String key = worktreeGroupKey(session);
                List<RelaySession> group = worktreeGroups.get(key);
                if (group == null) {
                    group = new ArrayList<>();
                    worktreeGroups.put(key, group);
                    worktreeGroupTitles.put(key, worktreeGroupTitle(session));
                }
                group.add(session);
            }
        }
        if (worktreeGroups.isEmpty()) {
            dashboardList.addView(emptyInlineText(isConnected ? "No WorkTrees" : "Connecting..."), matchWrapMargin(0, 8, 0, 8));
        } else {
            boolean firstGroup = true;
            for (Map.Entry<String, List<RelaySession>> entry : worktreeGroups.entrySet()) {
                addWorktreeGroupHeader(worktreeGroupTitles.get(entry.getKey()), entry.getValue().size(), firstGroup);
                firstGroup = false;
                for (RelaySession session : entry.getValue()) {
                    addDashboardSessionRow(session);
                }
            }
        }

        TextView terminalsLabel = smallLabel("Terminals");
        terminalsLabel.setPadding(0, worktreeGroups.isEmpty() ? dp(10) : dp(8), 0, dp(2));
        dashboardList.addView(terminalsLabel, matchWrap());

        if (terminals == 0) {
            dashboardList.addView(emptyInlineText("No Terminals"), matchWrapMargin(0, 4, 0, 0));
            return;
        }
        for (RelaySession session : sessions) {
            if ("terminal".equals(session.kind)) {
                addDashboardSessionRow(session);
            }
        }
    }

    private void addWorktreeGroupHeader(String title, int count, boolean firstGroup) {
        TextView header = new TextView(this);
        String safeTitle = title == null || title.isEmpty() ? "WorkTrees" : title;
        header.setText(safeTitle + "  " + count);
        header.setTextSize(12);
        header.setTypeface(Typeface.DEFAULT_BOLD);
        header.setTextColor(TEXT_SECOND);
        header.setSingleLine(true);
        header.setEllipsize(TextUtils.TruncateAt.END);
        header.setPadding(dp(2), firstGroup ? dp(2) : dp(9), dp(2), dp(3));
        dashboardList.addView(header, matchWrap());
    }

    private String worktreeGroupKey(RelaySession session) {
        return session.hostId + "\u001f" + session.scopeId + "\u001f" + sessionProject(session);
    }

    private String worktreeGroupTitle(RelaySession session) {
        String project = sessionProject(session);
        String scope = session.scopeLabel.isEmpty() ? session.hostName : session.scopeLabel;
        if (project.isEmpty()) return scope.isEmpty() ? "WorkTrees" : scope;
        if (scope.isEmpty() || "local".equals(scope)) return project;
        return project + " / " + scope;
    }

    private String sessionProject(RelaySession session) {
        if (session == null) return "";
        if (!session.project.isEmpty()) return session.project;
        return inferProjectFromCwd(session.cwd);
    }

    private static String inferProjectFromCwd(String cwd) {
        if (cwd == null || cwd.isEmpty()) return "";
        String marker = "/.tmux-worktree/worktrees/";
        int index = cwd.indexOf(marker);
        if (index < 0) return "";
        String rest = cwd.substring(index + marker.length());
        int slash = rest.indexOf("/");
        String project = slash >= 0 ? rest.substring(0, slash) : rest;
        return project.trim();
    }

    private void addDashboardSessionRow(RelaySession session) {
        View row = sessionRowView(session);
        row.setOnClickListener(v -> selectSessionAndOpen(session));
        row.setOnLongClickListener(v -> {
            showSessionActions(session);
            return true;
        });
        dashboardList.addView(row, matchWrapMargin(0, 0, 0, 2));
    }

    private TextView emptyInlineText(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(13);
        tv.setTextColor(TEXT_MUTED);
        tv.setGravity(Gravity.CENTER_VERTICAL);
        tv.setPadding(dp(7), dp(8), dp(7), dp(8));
        return tv;
    }

    private View sessionRowView(RelaySession session) {
        boolean isSelected = session.name.equals(selectedSession) && session.hostId.equals(selectedHostId);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(7), dp(7), dp(5), dp(7));

        int bgColor = isSelected ? ROW_SELECT : Color.TRANSPARENT;
        GradientDrawable rowBg = new GradientDrawable();
        rowBg.setColor(bgColor);
        rowBg.setCornerRadius(dp(5));
        row.setBackground(rowBg);

        TextView dot = new TextView(this);
        dot.setText("●");
        dot.setTextSize(11);
        dot.setTextColor(colorFor(session.hostId + "/" + session.name));
        LinearLayout.LayoutParams dotLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        dotLp.setMargins(0, 0, dp(7), 0);
        row.addView(dot, dotLp);

        LinearLayout textCol = new LinearLayout(this);
        textCol.setOrientation(LinearLayout.VERTICAL);
        row.addView(textCol, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        TextView name = new TextView(this);
        name.setText(sessionTitle(session));
        name.setTextSize(14);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setTextColor(isSelected ? ACCENT : TEXT_PRIMARY);
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        textCol.addView(name, matchWrap());

        TextView meta = new TextView(this);
        String scope = session.scopeLabel.isEmpty() ? session.hostName : session.scopeLabel;
        if ("terminal".equals(session.kind)) {
            String cwd = session.cwd.isEmpty() ? "terminal" : compact(session.cwd, 34);
            meta.setText(scope + " - terminal - " + cwd);
        } else {
            meta.setText(scope + " - " + session.windows + " window" + (session.windows == 1 ? "" : "s") + " - " + ago(session.activity) + (session.attached ? " - attached" : ""));
        }
        meta.setTextSize(11);
        meta.setTextColor(TEXT_MUTED);
        meta.setSingleLine(true);
        meta.setEllipsize(TextUtils.TruncateAt.END);
        textCol.addView(meta, matchWrap());

        TextView kill = new TextView(this);
        kill.setText("×");
        kill.setTextSize(16);
        kill.setTypeface(Typeface.DEFAULT_BOLD);
        kill.setTextColor(ERROR_C);
        kill.setGravity(Gravity.CENTER);
        kill.setPadding(dp(5), 0, dp(5), 0);
        kill.setFocusable(false);
        kill.setOnClickListener(v -> confirmKillSession(session));
        row.addView(kill, new LinearLayout.LayoutParams(dp(30), dp(32)));

        return row;
    }

    private GradientDrawable roundBg(int color, int radius, int strokeColor) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(color);
        bg.setCornerRadius(radius);
        if (strokeColor != Color.TRANSPARENT) bg.setStroke(dp(1), strokeColor);
        return bg;
    }

    private LinearLayout.LayoutParams weightLp(int weight, int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, weight);
        lp.setMargins(dp(l), dp(t), dp(r), dp(b));
        return lp;
    }

    private LinearLayout card(LinearLayout parent, String title) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(12), dp(10), dp(12), dp(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(SURFACE);
        bg.setCornerRadius(dp(8));
        bg.setStroke(dp(1), BORDER);
        card.setBackground(bg);
        LinearLayout.LayoutParams lp = matchWrapMargin(0, 0, 0, 8);
        parent.addView(card, lp);

        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextSize(12);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        heading.setTextColor(TEXT_SECOND);
        heading.setAllCaps(true);
        heading.setLetterSpacing(0.04f);
        heading.setPadding(0, 0, 0, dp(8));
        card.addView(heading, matchWrap());

        return card;
    }

    private LinearLayout section(LinearLayout parent, String title) {
        LinearLayout section = new LinearLayout(this);
        section.setOrientation(LinearLayout.VERTICAL);
        section.setPadding(dp(4), dp(4), dp(4), 0);
        section.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams lp = matchWrapMargin(0, 0, 0, 0);
        parent.addView(section, lp);

        TextView heading = new TextView(this);
        heading.setText(title);
        heading.setTextSize(11);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        heading.setTextColor(TEXT_SECOND);
        heading.setAllCaps(true);
        heading.setLetterSpacing(0.04f);
        heading.setPadding(0, 0, 0, dp(3));
        section.addView(heading, matchWrap());

        return section;
    }

    private TextView smallLabel(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(TEXT_MUTED);
        tv.setTextSize(11);
        tv.setTypeface(Typeface.DEFAULT_BOLD);
        tv.setAllCaps(true);
        tv.setLetterSpacing(0.02f);
        tv.setPadding(0, dp(6), 0, dp(2));
        return tv;
    }

    private TextView inlineStatusView(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextColor(TEXT_MUTED);
        tv.setTextSize(11);
        tv.setTypeface(Typeface.DEFAULT);
        tv.setSingleLine(true);
        tv.setEllipsize(TextUtils.TruncateAt.END);
        tv.setPadding(0, dp(2), dp(4), dp(2));
        return tv;
    }

    private EditText styledField(String explicit, String fallback, String hint, boolean password) {
        EditText et = new EditText(this);
        et.setHint(hint);
        et.setHintTextColor(TEXT_MUTED);
        et.setTextColor(TEXT_PRIMARY);
        et.setTextSize(14);
        et.setSingleLine(true);
        et.setText(explicit != null ? explicit : fallback);
        et.setPadding(dp(10), dp(8), dp(10), dp(8));
        et.setBackgroundColor(Color.TRANSPARENT);

        if (password) {
            et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            et.setTransformationMethod(PasswordTransformationMethod.getInstance());
        } else {
            et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        }

        GradientDrawable fieldBg = new GradientDrawable();
        fieldBg.setColor(SURFACE_2);
        fieldBg.setCornerRadius(dp(8));
        fieldBg.setStroke(dp(1), BORDER);
        et.setBackground(fieldBg);

        return et;
    }

    private TextView chipView(String text, int textColor, int bgColor) {
        TextView chip = new TextView(this);
        chip.setText(text);
        chip.setTextSize(12);
        chip.setTextColor(textColor);
        chip.setTypeface(Typeface.DEFAULT);
        chip.setPadding(dp(9), dp(4), dp(9), dp(4));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(bgColor);
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), BORDER);
        chip.setBackground(bg);
        chip.setSingleLine(true);
        return chip;
    }

    private void updateChip(TextView chip, String text, int textColor, int bgColor) {
        chip.setText(text);
        chip.setTextColor(textColor);
        GradientDrawable bg = (GradientDrawable) chip.getBackground();
        if (bg != null) {
            bg.setColor(bgColor);
            bg.setStroke(dp(1), bgColor == SURFACE ? BORDER : Color.TRANSPARENT);
        }
        chip.invalidate();
    }

    // Buttons

    private TextView primaryButton(String text) {
        return makeButton(text, ACCENT, Color.WHITE, ACCENT_PRESS);
    }

    private TextView secondaryButton(String text) {
        return makeButton(text, SURFACE_2, TEXT_SECOND, Color.rgb(50, 56, 68));
    }

    private TextView compactButton(String text) {
        TextView btn = makeButton(text, SURFACE, TEXT_SECOND, Color.rgb(38, 44, 54));
        btn.setTextSize(11);
        btn.setPadding(dp(8), dp(4), dp(8), dp(4));
        return btn;
    }

    private TextView dangerButton(String text) {
        return makeButton(text, Color.rgb(60, 30, 35), ERROR_C, Color.rgb(80, 40, 48));
    }

    private TextView makeButton(String text, int bgColor, int textColor, int pressColor) {
        TextView btn = new TextView(this);
        btn.setText(text);
        btn.setTextSize(13);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setTextColor(textColor);
        btn.setGravity(Gravity.CENTER);
        btn.setPadding(dp(12), dp(7), dp(12), dp(7));
        btn.setAllCaps(false);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(bgColor);
        bg.setCornerRadius(dp(8));
        if (bgColor == SURFACE_2 || bgColor == Color.rgb(60, 30, 35)) {
            bg.setStroke(dp(1), BORDER);
        }
        btn.setBackground(bg);

        // Press feedback
        btn.setOnTouchListener((v, event) -> {
            GradientDrawable d = (GradientDrawable) btn.getBackground();
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    d.setColor(pressColor);
                    v.invalidate();
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    d.setColor(bgColor);
                    v.invalidate();
                    break;
            }
            return false;
        });

        return btn;
    }

    private void addShortcutBtn(LinearLayout parent, String label, String sequence) {
        TextView btn = new TextView(this);
        btn.setText(label);
        btn.setTextSize(12);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setTextColor(TEXT_SECOND);
        btn.setGravity(Gravity.CENTER);
        btn.setPadding(dp(10), dp(6), dp(10), dp(6));
        btn.setAllCaps(false);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(SURFACE);
        bg.setCornerRadius(dp(8));
        bg.setStroke(dp(1), BORDER);
        btn.setBackground(bg);

        int pressBg = Color.rgb(45, 52, 64);
        btn.setOnTouchListener((v, event) -> {
            GradientDrawable d = (GradientDrawable) btn.getBackground();
            switch (event.getAction()) {
                case MotionEvent.ACTION_DOWN:
                    d.setColor(pressBg);
                    v.invalidate();
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    d.setColor(SURFACE);
                    v.invalidate();
                    break;
            }
            return false;
        });

        btn.setOnClickListener(v -> {
            if ("Msg".equals(label)) {
                toggleComposer();
            } else if ("Hide".equals(label)) {
                setShortcutsCollapsed(true);
            } else {
                sendTerminalInput(sequence);
            }
        });

        LinearLayout.LayoutParams lp = parent == shortcutBar
            ? new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            : new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
        lp.setMargins(dp(2), 0, dp(2), 0);
        parent.addView(btn, lp);
    }

    private void setShortcutsCollapsed(boolean collapsed) {
        shortcutsCollapsed = collapsed;
        if (collapsed) {
            composerVisible = false;
            if (composerPanel != null) composerPanel.setVisibility(View.GONE);
            if (messageInput != null) messageInput.clearFocus();
            hideKeyboard();
        }
        if (shortcutBar != null) shortcutBar.setVisibility(collapsed ? View.GONE : View.VISIBLE);
        if (shortcutCollapsedButton != null) shortcutCollapsedButton.setVisibility(collapsed ? View.VISIBLE : View.GONE);
        updateTerminalChromePadding();
        requestTerminalFitBurst();
    }

    private void toggleComposer() {
        composerVisible = !composerVisible;
        if (composerPanel != null) {
            composerPanel.setVisibility(composerVisible ? View.VISIBLE : View.GONE);
        }
        if (composerVisible) {
            focusMessageInput();
        } else {
            hideKeyboard();
        }
        updateTerminalChromePadding();
        requestTerminalFitBurst();
    }

    private void focusMessageInput() {
        composerVisible = true;
        if (composerPanel != null) {
            composerPanel.setVisibility(View.VISIBLE);
        }
        if (terminalWebView != null) {
            terminalWebView.clearFocus();
        }
        if (messageInput == null) return;
        messageInput.setFocusableInTouchMode(true);
        messageInput.requestFocus();
        messageInput.postDelayed(() -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) {
                imm.showSoftInput(messageInput, InputMethodManager.SHOW_IMPLICIT);
            }
            updateTerminalChromePadding();
            requestTerminalFitBurst();
        }, 40);
        messageInput.postDelayed(this::requestTerminalFitBurst, 320);
    }

    private void hideKeyboard() {
        View tokenView = messageInput;
        if (tokenView == null || tokenView.getWindowToken() == null) tokenView = getCurrentFocus();
        if (tokenView == null || tokenView.getWindowToken() == null) tokenView = getWindow().getDecorView();
        InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
        if (imm != null) {
            imm.hideSoftInputFromWindow(tokenView.getWindowToken(), 0);
        }
        if (messageInput != null) messageInput.clearFocus();
        if (terminalWebView != null) {
            terminalWebView.requestFocus();
        }
        updateTerminalChromePadding();
        if (terminalFrame != null) terminalFrame.postDelayed(this::requestTerminalFitBurst, 220);
    }

    private void showSessionActions(RelaySession session) {
        String title = sessionTitle(session);
        TextView titleView = new TextView(this);
        titleView.setText(title);
        titleView.setTextSize(18);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setTextColor(TEXT_PRIMARY);
        titleView.setPadding(dp(18), dp(16), dp(18), dp(4));
        String[] actions = new String[] { "Open terminal", "Send message", "Kill session" };
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setCustomTitle(titleView)
            .setItems(actions, (d, which) -> {
                selectedHostId = session.hostId;
                selectedSession = session.name;
                savePreferredHost(selectedHostId);
                updateSelectedHostBadge();
                updateSelectedSessionBadge();
                notifySessionAdapters();
                if (which == 0) {
                    openSession();
                    selectTab(1);
                } else if (which == 1) {
                    toggleComposer();
                    selectTab(1);
                } else if (which == 2) {
                    confirmKillSession(session);
                }
            })
            .create();
        dialog.setOnShowListener(d -> {
            if (dialog.getWindow() != null) {
                dialog.getWindow().setBackgroundDrawable(roundBg(SURFACE, dp(12), BORDER));
            }
            ListView list = dialog.getListView();
            if (list != null) {
                list.setBackgroundColor(SURFACE);
                list.setDividerHeight(0);
                list.post(() -> {
                    for (int i = 0; i < list.getChildCount(); i++) {
                        View child = list.getChildAt(i);
                        if (child instanceof TextView) {
                            ((TextView) child).setTextColor(i == 2 ? ERROR_C : TEXT_PRIMARY);
                        }
                    }
                });
            }
        });
        dialog.show();
    }

    private void confirmKillSession(RelaySession session) {
        TextView titleView = new TextView(this);
        titleView.setText("Kill session?");
        titleView.setTextSize(18);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        titleView.setTextColor(TEXT_PRIMARY);
        titleView.setPadding(dp(18), dp(16), dp(18), dp(4));
        TextView body = new TextView(this);
        body.setText(displayHost(session.hostId) + " / " + session.name);
        body.setTextSize(14);
        body.setTextColor(TEXT_SECOND);
        body.setPadding(dp(18), dp(8), dp(18), 0);
        AlertDialog dialog = new AlertDialog.Builder(this)
            .setCustomTitle(titleView)
            .setView(body)
            .setPositiveButton("Kill", (d, which) -> killSession(session))
            .setNegativeButton("Cancel", null)
            .create();
        dialog.setOnShowListener(d -> {
            if (dialog.getWindow() != null) {
                dialog.getWindow().setBackgroundDrawable(roundBg(SURFACE, dp(12), BORDER));
            }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(ERROR_C);
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(TEXT_SECOND);
        });
        dialog.show();
    }

    private void showCreateWorktreeDialog() {
        if (!isConnected) {
            setStatusUi("Not connected", WARNING);
            return;
        }
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(18), dp(8), dp(18), 0);

        TextView title = new TextView(this);
        title.setText("New WorkTree");
        title.setTextSize(18);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(TEXT_PRIMARY);
        title.setPadding(dp(18), dp(16), dp(18), dp(4));

        form.addView(smallLabel("Scope"), matchWrap());
        EditText scopeField = styledField(defaultScopeId(), "local", "local / remote-a / remote-b", false);
        form.addView(scopeField, matchWrapMargin(0, 2, 0, 8));

        form.addView(smallLabel("Project or path"), matchWrap());
        EditText targetField = styledField("", "", "project key or /repo/path", false);
        form.addView(targetField, matchWrapMargin(0, 2, 0, 8));

        form.addView(smallLabel("Title"), matchWrap());
        EditText nameField = styledField("", "", "optional", false);
        form.addView(nameField, matchWrapMargin(0, 2, 0, 8));

        form.addView(smallLabel("AI command"), matchWrap());
        EditText aiField = styledField("codex", "codex", "codex / claude", false);
        form.addView(aiField, matchWrapMargin(0, 2, 0, 8));

        form.addView(smallLabel("Branch"), matchWrap());
        EditText branchField = styledField("", "", "optional", false);
        form.addView(branchField, matchWrapMargin(0, 2, 0, 0));

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setCustomTitle(title)
            .setView(form)
            .setPositiveButton("Create", null)
            .setNegativeButton("Cancel", null)
            .create();
        dialog.setOnShowListener(d -> {
            if (dialog.getWindow() != null) {
                dialog.getWindow().setBackgroundDrawable(roundBg(SURFACE, dp(12), BORDER));
            }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(ACCENT);
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(TEXT_SECOND);
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                String target = targetField.getText().toString().trim();
                String ai = aiField.getText().toString().trim();
                if (target.isEmpty() || ai.isEmpty()) {
                    setStatusUi("Target and AI command required", WARNING);
                    return;
                }
                createWorktree(scopeField.getText().toString().trim(), target, nameField.getText().toString().trim(), ai, branchField.getText().toString().trim());
                dialog.dismiss();
            });
        });
        dialog.show();
    }

    private void showCreateTerminalDialog() {
        if (!isConnected) {
            setStatusUi("Not connected", WARNING);
            return;
        }
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(18), dp(8), dp(18), 0);

        TextView title = new TextView(this);
        title.setText("New Terminal");
        title.setTextSize(18);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(TEXT_PRIMARY);
        title.setPadding(dp(18), dp(16), dp(18), dp(4));

        form.addView(smallLabel("Scope"), matchWrap());
        EditText scopeField = styledField(defaultScopeId(), "local", "local / remote-a / remote-b", false);
        form.addView(scopeField, matchWrapMargin(0, 2, 0, 8));

        form.addView(smallLabel("Directory"), matchWrap());
        EditText cwdField = styledField(currentCwdHint(), "", "/path/to/dir", false);
        form.addView(cwdField, matchWrapMargin(0, 2, 0, 8));

        form.addView(smallLabel("Label"), matchWrap());
        EditText labelField = styledField("", "", "optional", false);
        form.addView(labelField, matchWrapMargin(0, 2, 0, 0));

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setCustomTitle(title)
            .setView(form)
            .setPositiveButton("Create", null)
            .setNegativeButton("Cancel", null)
            .create();
        dialog.setOnShowListener(d -> {
            if (dialog.getWindow() != null) {
                dialog.getWindow().setBackgroundDrawable(roundBg(SURFACE, dp(12), BORDER));
            }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(ACCENT);
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(TEXT_SECOND);
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                String cwd = cwdField.getText().toString().trim();
                if (cwd.isEmpty()) {
                    setStatusUi("Directory required", WARNING);
                    return;
                }
                createTerminal(scopeField.getText().toString().trim(), cwd, labelField.getText().toString().trim());
                dialog.dismiss();
            });
        });
        dialog.show();
    }

    private String defaultScopeId() {
        RelaySession selected = findSession(selectedHostId, selectedSession);
        if (selected != null && !selected.scopeId.isEmpty()) return selected.scopeId;
        if (!scopeStatuses.isEmpty()) return scopeStatuses.get(0).scopeId;
        return "local";
    }

    private String currentCwdHint() {
        RelaySession selected = findSession(selectedHostId, selectedSession);
        return selected == null ? "" : selected.cwd;
    }

    private static boolean looksLikePathValue(String value) {
        return value.startsWith("/") || value.startsWith("~/") || value.equals("~") || value.startsWith(".");
    }

    private void putIfNotEmpty(JSONObject payload, String key, String value) {
        if (value == null || value.trim().isEmpty()) return;
        try {
            payload.put(key, value.trim());
        } catch (Exception ignored) {
        }
    }

    private void createWorktree(String scopeId, String target, String name, String aiCommand, String branch) {
        if (hosts.isEmpty()) {
            setStatusUi("Mac admin connector offline", ERROR_C);
            listHosts();
            return;
        }
        RelayHost selected = preferredHost();
        if (selected == null || selected.hostId.isEmpty()) {
            setStatusUi("Mac admin connector offline", ERROR_C);
            return;
        }
        selectedHostId = selected.hostId;
        String requestId = "create-wt-" + System.currentTimeMillis();
        JSONObject payload = json(
            "type", "create_worktree",
            "hostId", selectedHostId,
            "requestId", requestId,
            "scopeId", scopeId.isEmpty() ? "local" : scopeId,
            "aiCommand", aiCommand
        );
        putIfNotEmpty(payload, looksLikePathValue(target) ? "path" : "project", target);
        putIfNotEmpty(payload, "name", name);
        putIfNotEmpty(payload, "branch", branch);
        setStatusUi("Creating WorkTree...", WARNING);
        sendJson(payload);
    }

    private void createTerminal(String scopeId, String cwd, String label) {
        if (hosts.isEmpty()) {
            setStatusUi("Mac admin connector offline", ERROR_C);
            listHosts();
            return;
        }
        RelayHost selected = preferredHost();
        if (selected == null || selected.hostId.isEmpty()) {
            setStatusUi("Mac admin connector offline", ERROR_C);
            return;
        }
        selectedHostId = selected.hostId;
        JSONObject payload = json(
            "type", "create_terminal",
            "hostId", selectedHostId,
            "requestId", "create-term-" + System.currentTimeMillis(),
            "scopeId", scopeId.isEmpty() ? "local" : scopeId,
            "cwd", cwd
        );
        putIfNotEmpty(payload, "label", label);
        setStatusUi("Creating Terminal...", WARNING);
        sendJson(payload);
    }

    private void loadSavedIdentity() {
        SharedPreferences prefs = getSharedPreferences(PREFS_IDENTITY, MODE_PRIVATE);
        String relay = getIntent().getStringExtra("relayUrl");
        String token = getIntent().getStringExtra("relaySecret");
        String hostId = getIntent().getStringExtra("hostId");
        if (relay == null || relay.isEmpty()) relay = prefs.getString("relayUrl", "");
        if (token == null || token.isEmpty()) token = prefs.getString("relaySecret", "");
        if ((pendingAutoHostId == null || pendingAutoHostId.isEmpty()) && hostId != null && !hostId.isEmpty()) {
            pendingAutoHostId = hostId;
        }
        if ((pendingAutoHostId == null || pendingAutoHostId.isEmpty())) {
            pendingAutoHostId = prefs.getString("hostId", "");
        }
        savedAutoConnect = prefs.getBoolean("autoConnect", false);
        relayInput.setText(relay == null ? "" : relay);
        tokenInput.setText(token == null ? "" : token);
    }

    private void saveIdentity(String relay, String token) {
        String hostId = selectedHostId == null || selectedHostId.isEmpty() ? pendingAutoHostId : selectedHostId;
        SharedPreferences.Editor editor = getSharedPreferences(PREFS_IDENTITY, MODE_PRIVATE)
            .edit()
            .putString("relayUrl", relay)
            .putString("relaySecret", token)
            .putBoolean("autoConnect", true);
        if (hostId != null && !hostId.isEmpty()) {
            editor.putString("hostId", hostId);
        }
        editor.apply();
        savedAutoConnect = true;
    }

    private void clearSavedIdentity() {
        getSharedPreferences(PREFS_IDENTITY, MODE_PRIVATE)
            .edit()
            .remove("relayUrl")
            .remove("relaySecret")
            .remove("hostId")
            .putBoolean("autoConnect", false)
            .apply();
        savedAutoConnect = false;
        pendingAutoHostId = "";
        pendingAutoOpenSession = null;
        selectedHostId = "";
        selectedSession = "";
        hosts.clear();
        sessions.clear();
        if (relayInput != null) relayInput.setText("");
        if (tokenInput != null) tokenInput.setText("");
        setIdentityExpanded(true);
        if (hostAdapter != null) hostAdapter.notifyDataSetChanged();
        updateSelectedHostBadge();
        updateSelectedSessionBadge();
        notifySessionAdapters();
    }

    private void savePreferredHost(String hostId) {
        if (hostId == null || hostId.isEmpty()) return;
        getSharedPreferences(PREFS_IDENTITY, MODE_PRIVATE)
            .edit()
            .putString("hostId", hostId)
            .apply();
    }

    private void setSavedAutoConnect(boolean enabled) {
        getSharedPreferences(PREFS_IDENTITY, MODE_PRIVATE)
            .edit()
            .putBoolean("autoConnect", enabled)
            .apply();
        savedAutoConnect = enabled;
    }

    private void showIdentityDialog() {
        if (isFinishing()) return;
        setIdentityExpanded(true);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(18), dp(8), dp(18), 0);

        TextView title = new TextView(this);
        title.setText("Connect identity");
        title.setTextSize(18);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setTextColor(TEXT_PRIMARY);
        title.setPadding(dp(18), dp(16), dp(18), dp(4));

        TextView relayLabel = smallLabel("Relay URL");
        form.addView(relayLabel, matchWrap());
        EditText relayField = styledField(relayInput.getText().toString(), "wss://relay.example.com", "wss://relay.example.com", false);
        form.addView(relayField, matchWrapMargin(0, 2, 0, 10));

        TextView tokenLabel = smallLabel("Identity Token");
        form.addView(tokenLabel, matchWrap());
        EditText tokenField = styledField(tokenInput.getText().toString(), "", "bearer token", true);
        form.addView(tokenField, matchWrapMargin(0, 2, 0, 0));

        AlertDialog dialog = new AlertDialog.Builder(this)
            .setCustomTitle(title)
            .setView(form)
            .setPositiveButton("Connect", null)
            .setNegativeButton("Cancel", null)
            .create();
        dialog.setOnShowListener(d -> {
            if (dialog.getWindow() != null) {
                dialog.getWindow().setBackgroundDrawable(roundBg(SURFACE, dp(12), BORDER));
            }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(ACCENT);
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(TEXT_SECOND);
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                String relay = relayField.getText().toString().trim();
                String token = tokenField.getText().toString().trim();
                if (relay.isEmpty() || token.isEmpty()) {
                    setStatusUi("Relay and token required", WARNING);
                    return;
                }
                relayInput.setText(relay);
                tokenInput.setText(token);
                dialog.dismiss();
                connect();
            });
        });
        dialog.show();
    }

    private void installIdentityEditStopper(EditText field) {
        field.setOnFocusChangeListener((v, hasFocus) -> {
            if (hasFocus) stopReconnectForIdentityEdit();
        });
        field.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) {}

            @Override public void onTextChanged(CharSequence s, int start, int before, int count) {
                if (field.hasFocus()) stopReconnectForIdentityEdit();
            }

            @Override public void afterTextChanged(Editable s) {}
        });
    }

    private void stopReconnectForIdentityEdit() {
        if (userDisconnectRequested && !reconnectScheduled && webSocket == null) return;
        disconnectAndForget();
        setStatusUi("Editing connection", WARNING);
    }

    // Protocol Methods

    private void connect() {
        userDisconnectRequested = false;
        cancelReconnect();
        setStatusUi("Connecting...", WARNING);
        String relay = relayInput.getText().toString().trim().replaceAll("/+$", "");
        String token = tokenInput.getText().toString().trim();
        if (relay.isEmpty() || token.isEmpty()) {
            userDisconnectRequested = true;
            setSavedAutoConnect(false);
            setIdentityExpanded(true);
            setStatusUi("Relay and token required", WARNING);
            return;
        }

        Request request;
        try {
            request = new Request.Builder()
                .url(relay + "/client")
                .header("Authorization", "Bearer " + token)
                .build();
        } catch (IllegalArgumentException e) {
            userDisconnectRequested = true;
            setSavedAutoConnect(false);
            setIdentityExpanded(true);
            setStatusUi("Invalid relay URL", ERROR_C);
            return;
        }

        ignoredSocket = webSocket;
        closeRelaySocket("reconnect");
        saveIdentity(relay, token);

        webSocket = httpClient.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket socket, Response response) {
                runOnUiThread(() -> {
                    if (socket != webSocket) return;
                    Log.i(TAG, "relay websocket open");
                    isConnected = true;
                    reconnectAttempt = 0;
                    setIdentityExpanded(false);
                    setStatusUi("Connected. Loading devices...", SUCCESS);
                    listHosts();
                });
            }

            @Override
            public void onMessage(WebSocket socket, String text) {
                if (socket != webSocket) return;
                handleMessage(text);
            }

            @Override
            public void onClosed(WebSocket socket, int code, String reason) {
                runOnUiThread(() -> {
                    if (socket == ignoredSocket) {
                        ignoredSocket = null;
                        return;
                    }
                    if (socket != webSocket && webSocket != null) return;
                    isConnected = false;
                    activeStreamId = null;
                    terminalStreamReopenScheduled = false;
                    webSocket = null;
                    rememberTerminalForReconnect();
                    if (userDisconnectRequested) {
                        setStatusUi("Disconnected", ERROR_C);
                    } else {
                        scheduleReconnect(reason == null || reason.isEmpty() ? "Disconnected" : reason);
                    }
                });
            }

            @Override
            public void onFailure(WebSocket socket, Throwable t, Response response) {
                runOnUiThread(() -> {
                    if (socket == ignoredSocket) {
                        ignoredSocket = null;
                        return;
                    }
                    if (socket != webSocket && webSocket != null) return;
                    Log.e(TAG, "relay websocket failure", t);
                    isConnected = false;
                    activeStreamId = null;
                    terminalStreamReopenScheduled = false;
                    webSocket = null;
                    rememberTerminalForReconnect();
                    if (response != null && (response.code() == 401 || response.code() == 403)) {
                        userDisconnectRequested = true;
                        setSavedAutoConnect(false);
                        setIdentityExpanded(true);
                        setStatusUi("Authentication failed", ERROR_C);
                        showIdentityDialog();
                        return;
                    }
                    String detail = t.getMessage() == null ? t.getClass().getSimpleName() : t.getMessage();
                    scheduleReconnect("Connection failed: " + detail);
                });
            }
        });
    }

    private void disconnect() {
        userDisconnectRequested = true;
        cancelReconnect();
        ignoredSocket = webSocket;
        closeRelaySocket("user disconnect");
        isConnected = false;
        activeStreamId = null;
        terminalStreamReopenScheduled = false;
        sessionRequests.clear();
        killRequests.clear();
    }

    private void disconnectAndForget() {
        setSavedAutoConnect(false);
        disconnect();
    }

    private void closeRelaySocket(String reason) {
        WebSocket socket = webSocket;
        webSocket = null;
        if (socket != null) {
            try {
                socket.close(1000, reason);
            } catch (Exception ignored) {
            }
        }
    }

    private void cancelReconnect() {
        reconnectScheduled = false;
        if (reconnectRunnable != null) {
            mainHandler.removeCallbacks(reconnectRunnable);
            reconnectRunnable = null;
        }
    }

    private void scheduleReconnect(String reason) {
        if (userDisconnectRequested || reconnectScheduled || isFinishing()) return;
        int delay = Math.min((int) Math.pow(2, Math.min(reconnectAttempt, 4)) * 1000, MAX_RECONNECT_DELAY_MS);
        reconnectAttempt++;
        reconnectScheduled = true;
        if (reconnectAttempt >= 3) {
            setIdentityExpanded(true);
        }
        setStatusUi(compact(reason, 34) + " - retry in " + Math.max(1, delay / 1000) + "s", WARNING);
        reconnectRunnable = () -> {
            reconnectScheduled = false;
            reconnectRunnable = null;
            if (!userDisconnectRequested && !isFinishing()) {
                connect();
            }
        };
        mainHandler.postDelayed(reconnectRunnable, delay);
    }

    private void rememberTerminalForReconnect() {
        if (!terminalMode || selectedHostId.isEmpty() || selectedSession.isEmpty()) return;
        pendingAutoHostId = selectedHostId;
        pendingAutoOpenSession = selectedSession;
    }

    private void listHosts() {
        if (!isConnected) {
            setStatusUi("Not connected", WARNING);
            return;
        }
        sendJson(json(
            "type", "list_hosts",
            "requestId", "hosts-" + System.currentTimeMillis()
        ));
    }

    private void refreshDashboard() {
        long now = System.currentTimeMillis();
        if (now - lastRefreshAt < 700) return;
        lastRefreshAt = now;
        listHosts();
    }

    private void listSessions() {
        listAllSessions();
    }

    private void listAllSessions() {
        sessionRequests.clear();
        if (!isConnected) {
            setStatusUi("Not connected", WARNING);
            return;
        }
        if (hosts.isEmpty()) {
            setStatusUi("No devices online", WARNING);
            return;
        }
        RelayHost selected = preferredHost();
        selectedHostId = selected.hostId;
        updateSelectedHostBadge();
        setStatusUi("Loading sessions...", SUCCESS);
        listScopeStatuses();
        String requestId = "sessions-" + selected.hostId + "-" + System.currentTimeMillis();
        latestSessionsRequestId = requestId;
        sessionRequests.put(requestId, selected);
        sendJson(json(
            "type", "list_sessions",
            "hostId", selected.hostId,
            "requestId", requestId
        ));
    }

    private void listScopeStatuses() {
        if (!isConnected || selectedHostId.isEmpty()) return;
        sendJson(json(
            "type", "list_scope_statuses",
            "hostId", selectedHostId,
            "requestId", "scopes-" + selectedHostId + "-" + System.currentTimeMillis()
        ));
    }

    private void listSessionsForHost(String hostId) {
        if (hostId.isEmpty()) return;
        String requestId = "sessions-" + hostId + "-" + System.currentTimeMillis();
        RelayHost host = findHost(hostId);
        if (host != null) sessionRequests.put(requestId, host);
        sendJson(json(
            "type", "list_sessions",
            "hostId", hostId,
            "requestId", requestId
        ));
    }

    private void openSession() {
        if ((selectedSession.isEmpty() || selectedHostId.isEmpty()) && !sessions.isEmpty()) {
            selectedHostId = sessions.get(0).hostId;
            selectedSession = sessions.get(0).name;
        }
        if (selectedHostId.isEmpty() || selectedSession.isEmpty()) return;
        savePreferredHost(selectedHostId);

        if (!openTerminalStream(true)) return;
        if (pendingAutoCommand != null && !pendingAutoCommand.isEmpty()) {
            String command = pendingAutoCommand;
            pendingAutoCommand = null;
            terminalWebView.postDelayed(() -> sendAgentMessage(command), 1000);
        }
    }

    private boolean openTerminalStream(boolean resetDisplay) {
        if (!isConnected || selectedHostId.isEmpty() || selectedSession.isEmpty()) return false;
        activeStreamId = UUID.randomUUID().toString();
        terminalStreamReopenScheduled = false;
        if (resetDisplay) pendingTerminalWrites.clear();
        updateSelectedSessionBadge();
        enterTerminalMode();
        Log.i(TAG, "open terminal host=" + selectedHostId + " session=" + selectedSession + " streamId=" + activeStreamId);
        if (resetDisplay) {
            resetTerminal("Opening " + selectedHostId + " / " + selectedSession + "\\r\\n");
        }
        sendJson(json(
            "type", "open_terminal",
            "hostId", selectedHostId,
            "streamId", activeStreamId,
            "session", selectedSession
        ));
        requestTerminalFitBurst();
        return true;
    }

    private void scheduleTerminalStreamReopen(String reason) {
        if (terminalStreamReopenScheduled || !terminalMode || !isConnected) return;
        if (selectedHostId.isEmpty() || selectedSession.isEmpty()) return;
        terminalStreamReopenScheduled = true;
        activeStreamId = null;
        setStatusUi(compact(reason, 34), WARNING);
        writeTerminal("\r\n[" + reason + "]\r\n");
        mainHandler.postDelayed(() -> {
            if (!terminalMode || !isConnected || selectedHostId.isEmpty() || selectedSession.isEmpty()) {
                terminalStreamReopenScheduled = false;
                return;
            }
            openTerminalStream(false);
        }, 180);
    }

    private void sendAgentMessage() {
        String text = messageInput.getText().toString();
        if (text.trim().isEmpty()) return;
        sendAgentMessage(text);
        messageInput.setText("");
        composerVisible = false;
        if (composerPanel != null) composerPanel.setVisibility(View.GONE);
        hideKeyboard();
    }

    private void sendAgentMessage(String text) {
        if (selectedHostId.isEmpty() || selectedSession.isEmpty()) return;
        Log.i(TAG, "send agent message host=" + selectedHostId + " session=" + selectedSession + " bytes=" + text.length());
        sendJson(json(
            "type", "send_agent_message",
            "hostId", selectedHostId,
            "requestId", "agent-" + System.currentTimeMillis(),
            "session", selectedSession,
            "message", text,
            "submit", true
        ));
    }

    private void killSession(RelaySession session) {
        if (session == null || session.hostId.isEmpty() || session.name.isEmpty()) return;
        String requestId = "kill-" + session.hostId + "-" + System.currentTimeMillis();
        killRequests.put(requestId, session);
        setStatusUi("Killing: " + compact(session.name, 22), WARNING);
        sendJson(json(
            "type", "kill_session",
            "hostId", session.hostId,
            "requestId", requestId,
            "session", session.name
        ));
    }

    private void sendTerminalInput(String data) {
        if (activeStreamId == null) {
            if (!openTerminalStream(false) || activeStreamId == null) return;
        }
        sendJson(json(
            "type", "terminal_input",
            "streamId", activeStreamId,
            "data", data
        ));
    }

    private void sendTerminalResize(int cols, int rows) {
        if (activeStreamId == null) return;
        sendJson(json(
            "type", "resize",
            "streamId", activeStreamId,
            "cols", cols,
            "rows", rows
        ));
    }

    private void requestTerminalFit() {
        if (terminalWebView == null || !terminalReady) return;
        terminalWebView.postDelayed(() ->
            terminalWebView.evaluateJavascript("window.fitTerminal&&window.fitTerminal();", null),
            80
        );
    }

    private void requestTerminalFitBurst() {
        if (terminalWebView == null || !terminalReady) return;
        int[] delays = new int[] { 0, 60, 160, 320, 640 };
        for (int delay : delays) {
            terminalWebView.postDelayed(() -> {
                if (terminalMode && terminalWebView != null && terminalReady) {
                    terminalWebView.evaluateJavascript("window.fitTerminal&&window.fitTerminal();", null);
                }
            }, delay);
        }
    }

    private void updateTerminalChromePadding() {
        if (terminalWebView == null || !terminalReady) return;
        int bottomPadding = shortcutsCollapsed ? 14 : 64;
        if (composerVisible && composerPanel != null && composerPanel.getVisibility() == View.VISIBLE) {
            bottomPadding = 132;
        }
        terminalWebView.evaluateJavascript("window.setTerminalChrome&&window.setTerminalChrome(" + bottomPadding + ");", null);
        requestTerminalFitBurst();
    }

    private void enterTerminalMode() {
        terminalMode = true;
        if (tabBarView != null) tabBarView.setVisibility(View.GONE);
        if (tabDividerView != null) tabDividerView.setVisibility(View.GONE);
        if (contextBarView != null) contextBarView.setVisibility(View.GONE);
        if (backButton != null) backButton.setVisibility(View.VISIBLE);
        if (identityToggleButton != null) identityToggleButton.setVisibility(View.GONE);
        if (refreshButton != null) refreshButton.setVisibility(View.GONE);
        if (statusDot != null) statusDot.setVisibility(View.GONE);
        if (statusText != null) statusText.setVisibility(View.GONE);
        String title = terminalTitle();
        if (toolbarTitle != null) {
            toolbarTitle.setText(title);
            toolbarTitle.setTextSize(15);
        }
        if (appBarView != null) {
            appBarView.setPadding(dp(8), dp(4), dp(8), dp(4));
            appBarView.setBackgroundColor(TERM_BG);
        }
        if (consoleTabContent != null) consoleTabContent.setPadding(0, 0, 0, 0);
        if (terminalFrame != null) terminalFrame.setBackgroundColor(TERM_BG);
        composerVisible = false;
        if (composerPanel != null) composerPanel.setVisibility(View.GONE);
        updateTerminalChromePadding();
        requestTerminalFitBurst();
    }

    private void exitTerminalMode() {
        composerVisible = false;
        hideKeyboard();
        if (activeStreamId != null) {
            sendJson(json("type", "close_terminal", "streamId", activeStreamId));
            activeStreamId = null;
        }
        terminalMode = false;
        terminalStreamReopenScheduled = false;
        pendingTerminalWrites.clear();
        if (tabBarView != null) tabBarView.setVisibility(View.GONE);
        if (tabDividerView != null) tabDividerView.setVisibility(View.GONE);
        if (contextBarView != null) contextBarView.setVisibility(View.VISIBLE);
        if (backButton != null) backButton.setVisibility(View.GONE);
        if (identityToggleButton != null) identityToggleButton.setVisibility(View.VISIBLE);
        if (refreshButton != null) refreshButton.setVisibility(View.VISIBLE);
        if (statusDot != null) statusDot.setVisibility(View.VISIBLE);
        if (statusText != null) statusText.setVisibility(View.VISIBLE);
        if (toolbarTitle != null) {
            toolbarTitle.setText("tw-dashboard");
            toolbarTitle.setTextSize(15);
        }
        if (appBarView != null) {
            appBarView.setPadding(dp(10), dp(4), dp(10), dp(4));
            appBarView.setBackgroundColor(SURFACE);
        }
        if (consoleTabContent != null) consoleTabContent.setPadding(dp(10), dp(8), dp(10), dp(8));
        if (connectTabContent != null) connectTabContent.setVisibility(View.VISIBLE);
        if (consoleTabContent != null) consoleTabContent.setVisibility(View.GONE);
        resetTerminal("Select a device and session to open a terminal...\\r\\n");
    }

    private void loadTerminalHtml() {
        terminalReady = false;
        String html = "<!doctype html><html><head>"
            + "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover\">"
            + "<link rel=\"stylesheet\" href=\"https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css\">"
            + "<style>"
            + "html,body,#terminal{margin:0;width:100%;height:100%;background:#0d0e10;overflow:hidden;}"
            + "body{touch-action:none;-webkit-user-select:none;user-select:none;}"
            + "#terminal .xterm{height:100%;padding:6px 4px 64px 4px;box-sizing:border-box;}"
            + ".xterm-viewport{background:#0d0e10!important;}"
            + "</style></head><body><div id=\"terminal\"></div>"
            + "<script src=\"https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js\"></script>"
            + "<script src=\"https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js\"></script>"
            + "<script>"
            + "var term,fitAddon,ready=false,pending=[],lastCols=0,lastRows=0;"
            + "function fit(){try{if(!ready||!term||!fitAddon)return;fitAddon.fit();if(term.cols&&term.rows&&(term.cols!==lastCols||term.rows!==lastRows)){lastCols=term.cols;lastRows=term.rows;TwBridge.resize(term.cols,term.rows);}}catch(e){}}"
            + "function fitSoon(delay){setTimeout(function(){if(window.requestAnimationFrame){requestAnimationFrame(fit);}else{fit();}},delay||0);}"
            + "function fitBurst(){[0,40,120,260,520].forEach(fitSoon);}"
            + "function setBottomPadding(px){var el=document.querySelector('#terminal .xterm');if(el){el.style.paddingBottom=px+'px';fitBurst();}}"
            + "function terminalLineHeight(){var row=document.querySelector('#terminal .xterm-rows>div');var h=row?row.getBoundingClientRect().height:0;return h||14;}"
            + "function installTouchScroll(){var el=document.getElementById('terminal');var sx=0,sy=0,ly=0,acc=0,scrolling=false;"
            + "el.addEventListener('touchstart',function(e){if(e.touches.length!==1)return;sx=e.touches[0].clientX;sy=e.touches[0].clientY;ly=sy;acc=0;scrolling=false;},{passive:true,capture:true});"
            + "el.addEventListener('touchmove',function(e){if(!ready||!term||e.touches.length!==1)return;var x=e.touches[0].clientX,y=e.touches[0].clientY;var dx=Math.abs(x-sx),dy=y-ly,totalY=Math.abs(y-sy);if(!scrolling&&totalY>8&&totalY>dx*1.2)scrolling=true;if(!scrolling)return;e.preventDefault();ly=y;acc+=dy;var lh=terminalLineHeight();var lines=acc/lh;if(Math.abs(lines)>=1){var whole=lines>0?Math.floor(lines):Math.ceil(lines);term.scrollLines(-whole);acc-=whole*lh;}},{passive:false,capture:true});"
            + "el.addEventListener('touchend',function(){scrolling=false;acc=0;},{passive:true,capture:true});"
            + "el.addEventListener('touchcancel',function(){scrolling=false;acc=0;},{passive:true,capture:true});"
            + "}"
            + "function init(){"
            + "term=new Terminal({fontFamily:'SF Mono,Menlo,ui-monospace,monospace',fontSize:12,lineHeight:1.12,cursorBlink:true,scrollback:5000,allowTransparency:false,"
            + "theme:{background:'#0d0e10',foreground:'#e6e6e8',cursor:'#b794f6',cursorAccent:'#0d0e10',selectionBackground:'rgba(183,148,246,0.3)',black:'#1a1d23',red:'#ff8272',green:'#9ae6b4',yellow:'#f6ad55',blue:'#90cdf4',magenta:'#d6bcfa',cyan:'#81e6d9',white:'#e6e6e8',brightBlack:'#5a5d68',brightRed:'#feb2b2',brightGreen:'#9ae6b4',brightYellow:'#fbd38d',brightBlue:'#90cdf4',brightMagenta:'#b794f6',brightCyan:'#81e6d9',brightWhite:'#ffffff'}});"
            + "fitAddon=new FitAddon.FitAddon();term.loadAddon(fitAddon);term.open(document.getElementById('terminal'));"
            + "installTouchScroll();"
            + "term.onData(function(d){TwBridge.input(d);});term.onResize(function(s){lastCols=s.cols;lastRows=s.rows;TwBridge.resize(s.cols,s.rows);});"
            + "window.addEventListener('resize',fitBurst);"
            + "if(window.visualViewport){visualViewport.addEventListener('resize',fitBurst);visualViewport.addEventListener('scroll',fitBurst);}"
            + "if(window.ResizeObserver){var ro=new ResizeObserver(fitBurst);ro.observe(document.documentElement);ro.observe(document.body);ro.observe(document.getElementById('terminal'));}"
            + "document.addEventListener('visibilitychange',function(){if(!document.hidden)fitBurst();});"
            + "ready=true;fitBurst();term.focus();for(var i=0;i<pending.length;i++)term.write(pending[i]);pending=[];TwBridge.ready();"
            + "}"
            + "window.writeTerminal=function(d){if(ready)term.write(d);else pending.push(d);};"
            + "window.resetTerminal=function(d){if(ready){term.reset();if(d)term.write(d);term.focus();}else{pending=[d||''];}};"
            + "window.sendInput=function(d){if(ready){term.write(d);TwBridge.input(d);}};"
            + "window.fitTerminal=function(){if(ready)fitBurst();};"
            + "window.setTerminalChrome=function(px){if(ready)setBottomPadding(px);};"
            + "if(window.Terminal&&window.FitAddon){init();}else{document.body.textContent='Loading xterm failed';TwBridge.ready();}"
            + "</script></body></html>";
        terminalWebView.loadDataWithBaseURL("https://tmux-worktree.local/", html, "text/html", "UTF-8", null);
    }

    private void resetTerminal(String text) {
        pendingTerminalWrites.clear();
        terminalDataBuffer.setLength(0);
        terminalFlushScheduled = false;
        if (!terminalReady) {
            pendingTerminalWrites.add(text);
            return;
        }
        String js = "window.resetTerminal(" + JSONObject.quote(text) + ");";
        terminalWebView.evaluateJavascript(js, null);
    }

    private void writeTerminal(String data) {
        if (!terminalReady) {
            pendingTerminalWrites.add(data);
            return;
        }
        terminalWebView.evaluateJavascript("window.writeTerminal(" + JSONObject.quote(data) + ");", null);
    }

    private void appendTerminalData(String data) {
        terminalDataBuffer.append(data);
        if (terminalFlushScheduled) return;
        terminalFlushScheduled = true;
        mainHandler.postDelayed(() -> {
            terminalFlushScheduled = false;
            if (terminalDataBuffer.length() == 0) return;
            String dataToWrite = terminalDataBuffer.toString();
            terminalDataBuffer.setLength(0);
            writeTerminal(dataToWrite);
        }, 16);
    }

    private boolean isActiveStream(String streamId) {
        return streamId == null || streamId.isEmpty() || (activeStreamId != null && streamId.equals(activeStreamId));
    }

    private boolean isRecoverableTerminalStreamError(String error) {
        String normalized = error == null ? "" : error.toLowerCase(Locale.ROOT);
        return normalized.contains("terminal stream is not open")
            || normalized.contains("terminal stream closed")
            || normalized.contains("host reconnected");
    }

    private final class TerminalBridge {
        @JavascriptInterface
        public void ready() {
            runOnUiThread(() -> {
                terminalReady = true;
                for (String data : new ArrayList<>(pendingTerminalWrites)) {
                    writeTerminal(data);
                }
                pendingTerminalWrites.clear();
                updateTerminalChromePadding();
                if (activeStreamId != null) requestTerminalFitBurst();
            });
        }

        @JavascriptInterface
        public void input(String data) {
            runOnUiThread(() -> sendTerminalInput(data));
        }

        @JavascriptInterface
        public void resize(int cols, int rows) {
            runOnUiThread(() -> sendTerminalResize(cols, rows));
        }
    }

    private void sendJson(JSONObject payload) {
        WebSocket socket = webSocket;
        if (socket != null) socket.send(payload.toString());
    }

    private JSONObject json(Object... values) {
        JSONObject object = new JSONObject();
        try {
            for (int i = 0; i + 1 < values.length; i += 2) {
                object.put(String.valueOf(values[i]), values[i + 1]);
            }
        } catch (Exception ignored) {
        }
        return object;
    }

    // Message Handling

    private void handleMessage(String raw) {
        JSONObject message;
        try {
            message = new JSONObject(raw);
        } catch (Exception ignored) {
            return;
        }

        String type = message.optString("type");
        if ("ready".equals(type)) {
            runOnUiThread(() -> {
                Log.i(TAG, "relay ready");
                setStatusUi("Connected. Loading devices...", SUCCESS);
            });
        } else if ("hosts".equals(type)) {
            JSONArray array = message.optJSONArray("hosts");
            List<RelayHost> parsed = parseHosts(array);
            runOnUiThread(() -> {
                hosts.clear();
                hosts.addAll(parsed);
                hostAdapter.notifyDataSetChanged();
                setStatusUi("Devices online: " + hosts.size(), SUCCESS);
                selectPreferredHost();
                Log.i(TAG, "hosts loaded count=" + hosts.size() + " selected=" + selectedHostId);
            });
        } else if ("sessions".equals(type)) {
            JSONArray array = message.optJSONArray("sessions");
            String requestId = message.optString("requestId");
            if (!requestId.isEmpty() && !requestId.equals(latestSessionsRequestId)) {
                Log.i(TAG, "ignored stale sessions response requestId=" + requestId);
                return;
            }
            RelayHost host = sessionRequests.remove(requestId);
            if (host == null) {
                Log.i(TAG, "ignored sessions response with unknown requestId=" + requestId);
                return;
            }
            List<RelaySession> parsed = parseSessions(array, host);
            String responseHostId = host == null ? selectedHostId : host.hostId;
            runOnUiThread(() -> {
                replaceSessionsForHost(responseHostId, parsed);
                if (!sessions.isEmpty() && selectedSession.isEmpty()) {
                    selectedHostId = sessions.get(0).hostId;
                    selectedSession = sessions.get(0).name;
                    savePreferredHost(selectedHostId);
                }
                notifySessionAdapters();
                updateSelectedHostBadge();
                updateSelectedSessionBadge();
                setStatusUi("Sessions loaded: " + sessions.size(), SUCCESS);
                Log.i(TAG, "sessions loaded count=" + sessions.size() + " names=" + sessions);
                RelaySession auto = pendingAutoOpenSession == null ? null : findSession(pendingAutoHostId, pendingAutoOpenSession);
                if (auto != null) {
                    selectedHostId = auto.hostId;
                    selectedSession = auto.name;
                    savePreferredHost(selectedHostId);
                    pendingAutoOpenSession = null;
                    pendingAutoHostId = null;
                    notifySessionAdapters();
                    terminalWebView.postDelayed(this::openSession, 300);
                    selectTab(1);
                }
            });
        } else if ("scope_statuses".equals(type)) {
            JSONArray array = message.optJSONArray("scopes");
            List<RelayScopeStatus> parsed = parseScopeStatuses(array);
            runOnUiThread(() -> {
                scopeStatuses.clear();
                scopeStatuses.addAll(parsed);
                updateRemoteStatusText();
                Log.i(TAG, "scope statuses count=" + scopeStatuses.size());
            });
        } else if ("worktree_created".equals(type) || "terminal_created".equals(type)) {
            JSONObject item = message.optJSONObject("session");
            RelayHost host = findHost(selectedHostId);
            RelaySession created = parseSession(item, host);
            runOnUiThread(() -> {
                if (created != null) {
                    removeSession(created.hostId, created.name);
                    sessions.add(created);
                    selectedHostId = created.hostId;
                    selectedSession = created.name;
                    savePreferredHost(selectedHostId);
                    notifySessionAdapters();
                    updateSelectedHostBadge();
                    updateSelectedSessionBadge();
                    setStatusUi(("terminal_created".equals(type) ? "Terminal" : "WorkTree") + " created", SUCCESS);
                    openSession();
                    selectTab(1);
                } else {
                    setStatusUi("Created. Refreshing...", SUCCESS);
                }
                mainHandler.postDelayed(this::listAllSessions, 700);
            });
        } else if ("agent_message_sent".equals(type)) {
            runOnUiThread(() -> setStatusUi("Sent: " + compact(message.optString("session"), 22), SUCCESS));
        } else if ("session_killed".equals(type)) {
            String requestId = message.optString("requestId");
            RelaySession killed = killRequests.remove(requestId);
            String killedName = message.optString("session", killed == null ? "" : killed.name);
            String killedHostId = killed == null ? selectedHostId : killed.hostId;
            runOnUiThread(() -> {
                removeSession(killedHostId, killedName);
                if (selectedHostId.equals(killedHostId) && selectedSession.equals(killedName)) {
                    selectedSession = "";
                    activeStreamId = null;
                    if (terminalMode) {
                        writeTerminal("\r\n[session killed]\r\n");
                    }
                }
                notifySessionAdapters();
                updateSelectedSessionBadge();
                setStatusUi("Killed: " + compact(killedName, 22), SUCCESS);
                mainHandler.postDelayed(this::listAllSessions, 500);
            });
        } else if ("terminal_data".equals(type)) {
            String data = message.optString("data");
            String streamId = message.optString("streamId");
            if (!data.isEmpty()) runOnUiThread(() -> {
                if (!isActiveStream(streamId)) return;
                appendTerminalData(data);
            });
        } else if ("terminal_exit".equals(type)) {
            String streamId = message.optString("streamId");
            runOnUiThread(() -> {
                if (!isActiveStream(streamId)) return;
                writeTerminal("\r\n[stream closed]\r\n");
                activeStreamId = null;
            });
        } else if ("error".equals(type)) {
            String error = message.optString("message", "unknown error");
            String requestId = message.optString("requestId");
            String streamId = message.optString("streamId");
            RelaySession failedKill = requestId.isEmpty() ? null : killRequests.remove(requestId);
            runOnUiThread(() -> {
                if (failedKill == null && !streamId.isEmpty() && (activeStreamId == null || !streamId.equals(activeStreamId))) {
                    Log.i(TAG, "ignored stale stream error streamId=" + streamId + " message=" + error);
                    return;
                }
                if (failedKill != null) {
                    setStatusUi("Kill failed: " + compact(error, 24), ERROR_C);
                } else if (isRecoverableTerminalStreamError(error) && terminalMode && !streamId.isEmpty() && streamId.equals(activeStreamId)) {
                    Log.i(TAG, "recovering terminal stream streamId=" + streamId + " message=" + error);
                    scheduleTerminalStreamReopen("Reopening terminal stream");
                } else {
                    setStatusUi("Error: " + error, ERROR_C);
                    if (terminalMode) writeTerminal("\r\n[error] " + error + "\r\n");
                }
            });
        }
    }

    private List<RelayHost> parseHosts(JSONArray array) {
        List<RelayHost> parsed = new ArrayList<>();
        if (array == null) return parsed;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            parsed.add(new RelayHost(
                item.optString("hostId"),
                item.optString("displayName"),
                item.optInt("clients")
            ));
        }
        return parsed;
    }

    private List<RelaySession> parseSessions(JSONArray array, RelayHost host) {
        List<RelaySession> parsed = new ArrayList<>();
        if (array == null) return parsed;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            RelaySession session = parseSession(item, host);
            if (session != null) parsed.add(session);
        }
        return parsed;
    }

    private RelaySession parseSession(JSONObject item, RelayHost host) {
        if (item == null) return null;
        String hostId = host == null ? selectedHostId : host.hostId;
        String hostName = host == null ? hostId : (host.displayName.isEmpty() ? host.hostId : host.displayName);
        return new RelaySession(
            hostId,
            hostName,
            item.optString("name"),
            item.optString("rawName"),
            item.optString("scopeId"),
            item.optString("scopeLabel"),
            item.optString("kind", "session"),
            item.optString("project"),
            item.optString("label"),
            item.optString("cwd"),
            item.optBoolean("attached"),
            item.optInt("windows"),
            item.optLong("created"),
            item.optLong("activity")
        );
    }

    private List<RelayScopeStatus> parseScopeStatuses(JSONArray array) {
        List<RelayScopeStatus> parsed = new ArrayList<>();
        if (array == null) return parsed;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            parsed.add(new RelayScopeStatus(
                item.optString("scopeId"),
                item.optString("scopeLabel"),
                item.optString("kind"),
                item.optBoolean("reachable"),
                item.optInt("sessionCount"),
                item.optString("error")
            ));
        }
        return parsed;
    }

    private void selectPreferredHost() {
        if (hosts.isEmpty()) {
            selectedHostId = "";
            updateSelectedHostBadge();
            return;
        }
        RelayHost selected = preferredHost();
        selectedHostId = selected.hostId;
        savePreferredHost(selectedHostId);
        hostAdapter.notifyDataSetChanged();
        updateSelectedHostBadge();
        pendingAutoHostId = null;
        listSessions();
    }

    private RelayHost preferredHost() {
        String preferred = pendingAutoHostId;
        if (preferred == null || preferred.isEmpty()) preferred = selectedHostId;
        RelayHost selected = findHost(preferred);
        if (selected != null) return selected;

        for (RelayHost host : hosts) {
            if ("mac-admin".equals(host.hostId)) return host;
        }
        for (RelayHost host : hosts) {
            String id = host.hostId == null ? "" : host.hostId.toLowerCase(Locale.ROOT);
            String name = host.displayName == null ? "" : host.displayName.toLowerCase(Locale.ROOT);
            if (id.contains("admin") || name.contains("admin")) return host;
        }
        return hosts.get(0);
    }

    private RelaySession findSession(String hostId, String name) {
        for (RelaySession session : sessions) {
            boolean hostMatches = hostId == null || hostId.isEmpty() || session.hostId.equals(hostId);
            if (hostMatches && session.name.equals(name)) return session;
        }
        return null;
    }

    private void removeSession(String hostId, String name) {
        for (int i = sessions.size() - 1; i >= 0; i--) {
            RelaySession session = sessions.get(i);
            boolean hostMatches = hostId == null || hostId.isEmpty() || session.hostId.equals(hostId);
            if (hostMatches && session.name.equals(name)) {
                sessions.remove(i);
            }
        }
    }

    private void replaceSessionsForHost(String hostId, List<RelaySession> replacement) {
        if (hostId == null || hostId.isEmpty()) {
            sessions.clear();
            sessions.addAll(replacement);
            return;
        }
        for (int i = sessions.size() - 1; i >= 0; i--) {
            if (hostId.equals(sessions.get(i).hostId)) {
                sessions.remove(i);
            }
        }
        sessions.addAll(replacement);
    }

    // UI Update Methods

    private void setStatusUi(String text, int color) {
        statusText.setText(text);
        statusText.setTextColor(color);
        statusDot.setTextColor(color);
    }

    private void updateSelectedHostBadge() {
        String label;
        int textColor, bgColor;
        if (selectedHostId.isEmpty()) {
            label = "No device selected";
            textColor = TEXT_MUTED;
            bgColor = SURFACE_2;
        } else {
            RelayHost h = findHost(selectedHostId);
            label = h != null ? h.displayName.isEmpty() ? selectedHostId : h.displayName : selectedHostId;
            textColor = TEXT_PRIMARY;
            bgColor = Color.rgb(25, 55, 85);
        }
        updateChip(selectedHostBadge, label, textColor, bgColor);
        updateChip(consoleHostChip, compact(label, 18), textColor, bgColor);
    }

    private void updateSelectedSessionBadge() {
        String label;
        int textColor, bgColor;
        if (selectedSession.isEmpty()) {
            label = "No session selected";
            textColor = TEXT_MUTED;
            bgColor = SURFACE_2;
        } else {
            String hostLabel = displayHost(selectedHostId);
            RelaySession live = findSession(selectedHostId, selectedSession);
            String sessionLabel = live == null ? selectedSession : sessionTitle(live);
            label = (hostLabel.isEmpty() ? "" : hostLabel + " / ") + sessionLabel;
            textColor = TEXT_PRIMARY;
            bgColor = Color.rgb(25, 55, 85);
        }
        updateChip(selectedSessionBadge, label, textColor, bgColor);
        updateChip(consoleSessionChip, compact(label, 28), textColor, bgColor);
    }

    private void updateRemoteStatusText() {
        if (remoteStatusText == null) return;
        if (scopeStatuses.isEmpty()) {
            updateChip(remoteStatusText, "Remotes: checking", TEXT_MUTED, SURFACE_2);
            return;
        }
        StringBuilder text = new StringBuilder();
        boolean allReachable = true;
        int shown = 0;
        for (RelayScopeStatus status : scopeStatuses) {
            if (shown > 0) text.append(" · ");
            String label = status.scopeLabel.isEmpty() ? status.scopeId : status.scopeLabel;
            text.append(label);
            if (status.reachable) {
                text.append(" ").append(status.sessionCount);
            } else {
                text.append(" off");
                allReachable = false;
            }
            shown++;
            if (shown >= 4 && scopeStatuses.size() > shown) {
                text.append(" · +").append(scopeStatuses.size() - shown);
                break;
            }
        }
        updateChip(remoteStatusText, compact(text.toString(), 42), allReachable ? SUCCESS : WARNING, SURFACE_2);
    }

    private RelayHost findHost(String hostId) {
        for (RelayHost h : hosts) {
            if (h.hostId.equals(hostId)) return h;
        }
        return null;
    }

    private String displayHost(String hostId) {
        if (hostId == null || hostId.isEmpty()) return "";
        RelayHost host = findHost(hostId);
        if (host == null) return hostId;
        return host.displayName.isEmpty() ? host.hostId : host.displayName;
    }

    private String terminalTitle() {
        if (selectedSession.isEmpty()) return "terminal";
        RelaySession live = findSession(selectedHostId, selectedSession);
        if (live == null) return compact(selectedSession, 34);
        String scope = live.scopeLabel.isEmpty() ? displayHost(selectedHostId) : live.scopeLabel;
        String label = sessionTitle(live);
        return (scope.isEmpty() ? label : scope + " / " + label) + ":1";
    }

    private String sessionTitle(RelaySession session) {
        if (session == null) return "";
        if (!session.label.isEmpty()) return session.label;
        if (!session.rawName.isEmpty()) return session.rawName;
        return session.name;
    }

    private static String compact(String value, int max) {
        if (value == null) return "";
        if (value.length() <= max) return value;
        if (max <= 3) return value.substring(0, max);
        return value.substring(0, max - 3) + "...";
    }

    private static String ago(long ts) {
        if (ts <= 0) return "unknown";
        long seconds = Math.max(0, System.currentTimeMillis() / 1000 - ts);
        if (seconds < 60) return "just now";
        if (seconds < 3600) return (seconds / 60) + "m ago";
        if (seconds < 86400) return (seconds / 3600) + "h ago";
        return (seconds / 86400) + "d ago";
    }

    private static int colorFor(String name) {
        int[] colors = {
            Color.rgb(246, 135, 179),
            Color.rgb(154, 230, 180),
            Color.rgb(246, 173, 85),
            Color.rgb(144, 205, 244),
            Color.rgb(214, 188, 250),
            Color.rgb(129, 230, 217),
            Color.rgb(251, 211, 141),
            Color.rgb(254, 178, 178)
        };
        return colors[Math.abs(name == null ? 0 : name.hashCode()) % colors.length];
    }

    private static String stripAnsi(String input) {
        String output = OSC.matcher(input).replaceAll("");
        output = CHARSET.matcher(output).replaceAll("");
        output = CSI.matcher(output).replaceAll("");
        return output.replace("=", "").replace(">", "").replace("\r", "");
    }

    private static final Pattern OSC = Pattern.compile("\\u001B\\][^\\u0007]*(\\u0007|\\u001B\\\\)");
    private static final Pattern CHARSET = Pattern.compile("\\u001B[()#][0-9A-Za-z]");
    private static final Pattern CSI = Pattern.compile("\\u001B\\[[0-?]*[ -/]*[@-~]");

    // Data Models & Adapters

    static final class RelayHost {
        final String hostId;
        final String displayName;
        final int clients;

        RelayHost(String hostId, String displayName, int clients) {
            this.hostId = hostId;
            this.displayName = displayName == null ? "" : displayName;
            this.clients = clients;
        }
    }

    static final class RelaySession {
        final String hostId;
        final String hostName;
        final String name;
        final String rawName;
        final String scopeId;
        final String scopeLabel;
        final String kind;
        final String project;
        final String label;
        final String cwd;
        final boolean attached;
        final int windows;
        final long created;
        final long activity;

        RelaySession(String hostId, String hostName, String name, String rawName, String scopeId, String scopeLabel, String kind, String project, String label, String cwd, boolean attached, int windows, long created, long activity) {
            this.hostId = hostId == null ? "" : hostId;
            this.hostName = hostName == null || hostName.isEmpty() ? this.hostId : hostName;
            this.name = name == null ? "" : name;
            this.rawName = rawName == null ? "" : rawName;
            this.scopeId = scopeId == null ? "" : scopeId;
            this.scopeLabel = scopeLabel == null ? "" : scopeLabel;
            this.kind = kind == null || kind.isEmpty() ? "session" : kind;
            this.project = project == null ? "" : project;
            this.label = label == null ? "" : label;
            this.cwd = cwd == null ? "" : cwd;
            this.attached = attached;
            this.windows = windows;
            this.created = created;
            this.activity = activity;
        }

        @Override
        public String toString() {
            return hostId + "/" + name;
        }
    }

    static final class RelayScopeStatus {
        final String scopeId;
        final String scopeLabel;
        final String kind;
        final boolean reachable;
        final int sessionCount;
        final String error;

        RelayScopeStatus(String scopeId, String scopeLabel, String kind, boolean reachable, int sessionCount, String error) {
            this.scopeId = scopeId == null ? "" : scopeId;
            this.scopeLabel = scopeLabel == null ? "" : scopeLabel;
            this.kind = kind == null ? "" : kind;
            this.reachable = reachable;
            this.sessionCount = sessionCount;
            this.error = error == null ? "" : error;
        }
    }

    // Host adapter

    private final class HostAdapter extends BaseAdapter {
        @Override
        public int getCount() { return hosts.size(); }

        @Override
        public Object getItem(int position) { return hosts.get(position); }

        @Override
        public long getItemId(int position) { return position; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            RelayHost host = hosts.get(position);
            boolean isSelected = host.hostId.equals(selectedHostId);

            LinearLayout row = new LinearLayout(MainActivity.this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(7), dp(7), dp(6), dp(7));

            int bgColor = isSelected ? ROW_SELECT : Color.TRANSPARENT;
            GradientDrawable rowBg = new GradientDrawable();
            rowBg.setColor(bgColor);
            rowBg.setCornerRadius(dp(5));
            row.setBackground(rowBg);

            // Left accent bar for selected
            if (isSelected) {
                View accent = new View(MainActivity.this);
                GradientDrawable accentBg = new GradientDrawable();
                accentBg.setColor(ACCENT);
                accent.setBackground(accentBg);
                LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(dp(2), dp(22));
                alp.setMargins(0, 0, dp(8), 0);
                row.addView(accent, alp);
            }

            // Text column
            LinearLayout textCol = new LinearLayout(MainActivity.this);
            textCol.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams tclp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
            tclp.setMargins(isSelected ? 0 : dp(10), 0, dp(6), 0);
            row.addView(textCol, tclp);

            // Display name
            TextView name = new TextView(MainActivity.this);
            String display = host.displayName.isEmpty() ? host.hostId : host.displayName;
            name.setText(display);
            name.setTextSize(14);
            name.setTypeface(Typeface.DEFAULT_BOLD);
            name.setTextColor(isSelected ? ACCENT : TEXT_PRIMARY);
            name.setSingleLine(true);
            textCol.addView(name, matchWrap());

            // Subtitle: hostId + clients
            TextView sub = new TextView(MainActivity.this);
            sub.setText(host.hostId + " - " + host.clients + " client" + (host.clients != 1 ? "s" : ""));
            sub.setTextSize(11);
            sub.setTextColor(TEXT_MUTED);
            sub.setSingleLine(true);
            textCol.addView(sub, matchWrap());

            // Checkmark for selected
            if (isSelected) {
                TextView check = new TextView(MainActivity.this);
                check.setText("✓");
                check.setTextSize(14);
                check.setTextColor(ACCENT);
                check.setPadding(dp(6), 0, 0, 0);
                row.addView(check, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            }

            return row;
        }
    }

    // Session adapter

    private final class SessionAdapter extends BaseAdapter {
        private final String filterKind;

        SessionAdapter(String filterKind) {
            this.filterKind = filterKind;
        }

        RelaySession sessionAt(int position) {
            int seen = 0;
            for (RelaySession session : sessions) {
                if (!matches(session)) continue;
                if (seen == position) return session;
                seen++;
            }
            return null;
        }

        private boolean matches(RelaySession session) {
            if ("terminal".equals(filterKind)) return "terminal".equals(session.kind);
            return !"terminal".equals(session.kind);
        }

        @Override
        public int getCount() {
            int count = 0;
            for (RelaySession session : sessions) {
                if (matches(session)) count++;
            }
            return count;
        }

        @Override
        public Object getItem(int position) { return sessionAt(position); }

        @Override
        public long getItemId(int position) { return position; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            RelaySession session = sessionAt(position);
            if (session == null) return new View(MainActivity.this);
            boolean isSelected = session.name.equals(selectedSession) && session.hostId.equals(selectedHostId);

            LinearLayout row = new LinearLayout(MainActivity.this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(7), dp(7), dp(5), dp(7));

            int bgColor = isSelected ? ROW_SELECT : Color.TRANSPARENT;
            GradientDrawable rowBg = new GradientDrawable();
            rowBg.setColor(bgColor);
            rowBg.setCornerRadius(dp(5));
            row.setBackground(rowBg);

            TextView dot = new TextView(MainActivity.this);
            dot.setText("●");
            dot.setTextSize(11);
            dot.setTextColor(colorFor(session.hostId + "/" + session.name));
            LinearLayout.LayoutParams dotLp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            dotLp.setMargins(0, 0, dp(7), 0);
            row.addView(dot, dotLp);

            LinearLayout textCol = new LinearLayout(MainActivity.this);
            textCol.setOrientation(LinearLayout.VERTICAL);
            LinearLayout.LayoutParams colLp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1);
            row.addView(textCol, colLp);

            TextView name = new TextView(MainActivity.this);
            name.setText(sessionTitle(session));
            name.setTextSize(14);
            name.setTypeface(Typeface.DEFAULT_BOLD);
            name.setTextColor(isSelected ? ACCENT : TEXT_PRIMARY);
            name.setSingleLine(true);
            name.setEllipsize(TextUtils.TruncateAt.END);
            textCol.addView(name, matchWrap());

            TextView meta = new TextView(MainActivity.this);
            String scope = session.scopeLabel.isEmpty() ? session.hostName : session.scopeLabel;
            if ("terminal".equals(session.kind)) {
                String cwd = session.cwd.isEmpty() ? "terminal" : compact(session.cwd, 34);
                meta.setText(scope + " - terminal - " + cwd);
            } else {
                meta.setText(scope + " - " + session.windows + " window" + (session.windows == 1 ? "" : "s") + " - " + ago(session.activity) + (session.attached ? " - attached" : ""));
            }
            meta.setTextSize(11);
            meta.setTextColor(TEXT_MUTED);
            meta.setSingleLine(true);
            meta.setEllipsize(TextUtils.TruncateAt.END);
            textCol.addView(meta, matchWrap());

            TextView kill = new TextView(MainActivity.this);
            kill.setText("×");
            kill.setTextSize(16);
            kill.setTypeface(Typeface.DEFAULT_BOLD);
            kill.setTextColor(ERROR_C);
            kill.setGravity(Gravity.CENTER);
            kill.setPadding(dp(5), 0, dp(5), 0);
            kill.setFocusable(false);
            kill.setOnClickListener(v -> confirmKillSession(session));
            row.addView(kill, new LinearLayout.LayoutParams(dp(30), dp(32)));

            return row;
        }
    }
}
