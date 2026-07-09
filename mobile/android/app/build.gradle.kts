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
        versionCode = 10000
        versionName = "1.0.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
