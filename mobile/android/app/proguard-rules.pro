# Project-specific R8 rules for the release build.
#
# ML Kit barcode scanning remains the bundled/offline artifact. Its AAR ships
# the consumer rules required by its JNI and dynamically registered components,
# so retaining the whole com.google.mlkit namespace here would defeat shrinking.

# TerminalWebView exposes its bridge through WebView's annotation-based lookup.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# RelayConnectionService (core runtime package) resolves the process-restart composition
# bootstrap reflectively via Class.forName + getField("INSTANCE") so the core package never
# takes a compile-time dependency on the app/DI layer. R8's reachability analysis does not
# follow reflection string literals, and the app-layer object has no static reference anywhere
# else, so without this rule release shrinking/minification removes or renames the object and
# the START_STICKY self-heal fails soft (resolve() -> null -> stop-on-settle) in shipped APKs
# while debug builds keep working. Keep the concrete object's name, its INSTANCE field, and its
# interface methods; also keep any future implementation of the core bootstrap seam.
-keep class com.tmuxworktree.mobile.app.RelayV2ServiceRuntimeBootstrap {
    public static ** INSTANCE;
    <methods>;
}
-keep class * implements com.tmuxworktree.mobile.core.relay.runtime.RelayV2ServiceProcessBootstrap {
    <methods>;
}
