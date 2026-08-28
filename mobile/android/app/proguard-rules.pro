# Project-specific R8 rules for the release build.
#
# ML Kit barcode scanning remains the bundled/offline artifact. Its AAR ships
# the consumer rules required by its JNI and dynamically registered components,
# so retaining the whole com.google.mlkit namespace here would defeat shrinking.

# TerminalWebView exposes its bridge through WebView's annotation-based lookup.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
