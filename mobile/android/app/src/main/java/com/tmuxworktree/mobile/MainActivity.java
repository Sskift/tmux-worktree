package com.tmuxworktree.mobile;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/**
 * Internal compatibility shim for installs that still restore the legacy activity class.
 * The exported launcher and all product behavior live in {@link V2Activity}.
 */
@Deprecated
public final class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Intent source = getIntent();
        Intent replacement = new Intent(source);
        PairingIntentConsumer.INSTANCE.scrub(source);
        replacement.setClass(this, V2Activity.class);
        try {
            startActivity(replacement);
        } finally {
            PairingIntentConsumer.INSTANCE.scrub(replacement);
        }
        finish();
    }
}
