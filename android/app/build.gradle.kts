plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.dalbit.reader"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.dalbit.reader"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.3.0"
    }

    signingConfigs {
        // Committed debug key (not secret) so new builds install over old ones.
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") { signingConfig = signingConfigs.getByName("debug") }
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug") // personal sideload build
        }
    }

    buildFeatures { buildConfig = true }

    androidResources {
        // Models and WASM are already compressed / memory-mapped better uncompressed.
        noCompress += listOf("onnx", "wasm", "bin", "spm", "gz")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
