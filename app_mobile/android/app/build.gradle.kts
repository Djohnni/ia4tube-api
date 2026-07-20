plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.gms.google-services")
}

val googleServicesFile = layout.projectDirectory.file("google-services.json").asFile
if (!googleServicesFile.isFile) {
    throw org.gradle.api.GradleException(
        "Missing app/google-services.json. Firebase/FCM builds must include this file."
    )
}

val uploadStorePassword = providers.gradleProperty("IA4TUBE_UPLOAD_STORE_PASSWORD")
    .orElse(providers.environmentVariable("IA4TUBE_UPLOAD_STORE_PASSWORD"))
val uploadKeyPassword = providers.gradleProperty("IA4TUBE_UPLOAD_KEY_PASSWORD")
    .orElse(providers.environmentVariable("IA4TUBE_UPLOAD_KEY_PASSWORD"))
    .orElse(uploadStorePassword)

val productionApiBase = "https://ia4tube-api.onrender.com"
val explicitDebugProductDiscoveryApiBase = providers
    .gradleProperty("IA4TUBE_PRODUCT_DISCOVERY_API_BASE")
    .orNull
    ?.trim()
    ?.trimEnd('/')
    ?.takeIf { it.isNotBlank() }
val debugProductDiscoveryApiBase = explicitDebugProductDiscoveryApiBase ?: productionApiBase

fun String.asBuildConfigString(): String {
    return "\"" + replace("\\", "\\\\").replace("\"", "\\\"") + "\""
}

android {
    namespace = "br.com.ia4tube.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.ia4tube.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 26
        versionName = "0.2.15"

        buildConfigField("String", "API_BASE", productionApiBase.asBuildConfigString())
        buildConfigField("String", "PRODUCT_DISCOVERY_API_BASE", productionApiBase.asBuildConfigString())
    }

    signingConfigs {
        create("release") {
            storeFile = file("C:/IA4TubeKeys/upload-keystore.jks")
            storePassword = uploadStorePassword.orNull
            keyAlias = "ia4tube"
            keyPassword = uploadKeyPassword.orNull
        }
    }

    buildTypes {
        debug {
            buildConfigField(
                "String",
                "PRODUCT_DISCOVERY_API_BASE",
                debugProductDiscoveryApiBase.asBuildConfigString()
            )
            manifestPlaceholders["productDiscoveryUsesCleartext"] =
                debugProductDiscoveryApiBase.startsWith("http://").toString()
        }
        release {
            buildConfigField(
                "String",
                "PRODUCT_DISCOVERY_API_BASE",
                productionApiBase.asBuildConfigString()
            )
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    val firebaseBom = platform("com.google.firebase:firebase-bom:33.7.0")

    implementation(composeBom)
    implementation(firebaseBom)
    androidTestImplementation(composeBom)

    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-core")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.navigation:navigation-compose:2.8.3")
    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("com.google.firebase:firebase-messaging")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("io.coil-kt:coil-compose:2.7.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")

    testImplementation("junit:junit:4.13.2")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
