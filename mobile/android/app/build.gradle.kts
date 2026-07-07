plugins {
    id("com.android.application")
}

android {
    namespace = "com.tmuxworktree.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.tmuxworktree.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 1206
        versionName = "0.12.6"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
