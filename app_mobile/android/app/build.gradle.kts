import groovy.json.JsonSlurper

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("com.google.gms.google-services")
}

val uploadStorePassword = providers.gradleProperty("IA4TUBE_UPLOAD_STORE_PASSWORD")
    .orElse(providers.environmentVariable("IA4TUBE_UPLOAD_STORE_PASSWORD"))
val uploadKeyPassword = providers.gradleProperty("IA4TUBE_UPLOAD_KEY_PASSWORD")
    .orElse(providers.environmentVariable("IA4TUBE_UPLOAD_KEY_PASSWORD"))
    .orElse(uploadStorePassword)

val productionApiBase = "https://ia4tube-api.onrender.com"
val stagingApiBase = "https://ia4tube-api-staging-checkpoint-a.onrender.com"
val productionPlayStoreUrl = "https://play.google.com/store/apps/details?id=com.ia4tube.app"
val productionSupportUrl = "https://wa.me/554791049079"
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
        versionCode = 28
        versionName = "0.2.16"

        buildConfigField("String", "API_BASE", productionApiBase.asBuildConfigString())
        buildConfigField("String", "PRODUCT_DISCOVERY_API_BASE", productionApiBase.asBuildConfigString())
        buildConfigField("String", "PLAY_STORE_URL", productionPlayStoreUrl.asBuildConfigString())
        buildConfigField("String", "SUPPORT_URL", productionSupportUrl.asBuildConfigString())
        buildConfigField("boolean", "IS_STAGING", "false")
        buildConfigField("boolean", "FCM_REGISTRATION_ENABLED", "true")
        buildConfigField("boolean", "NOTIFICATIONS_ENABLED", "true")
        buildConfigField("boolean", "MOBILE_ANALYTICS_ENABLED", "true")
        buildConfigField("boolean", "PAYMENTS_ENABLED", "true")
        buildConfigField("boolean", "SUPPORT_ENABLED", "true")
        buildConfigField("boolean", "APP_UPDATE_ENABLED", "true")
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
        create("staging") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".staging"
            versionNameSuffix = "-staging"
            signingConfig = signingConfigs.getByName("debug")

            buildConfigField("String", "API_BASE", stagingApiBase.asBuildConfigString())
            buildConfigField("String", "PRODUCT_DISCOVERY_API_BASE", stagingApiBase.asBuildConfigString())
            buildConfigField("String", "PLAY_STORE_URL", "".asBuildConfigString())
            buildConfigField("String", "SUPPORT_URL", "".asBuildConfigString())
            buildConfigField("boolean", "IS_STAGING", "true")
            buildConfigField("boolean", "FCM_REGISTRATION_ENABLED", "false")
            buildConfigField("boolean", "NOTIFICATIONS_ENABLED", "false")
            buildConfigField("boolean", "MOBILE_ANALYTICS_ENABLED", "false")
            buildConfigField("boolean", "PAYMENTS_ENABLED", "false")
            buildConfigField("boolean", "SUPPORT_ENABLED", "false")
            buildConfigField("boolean", "APP_UPDATE_ENABLED", "false")
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

val productionGoogleServicesFile = layout.projectDirectory.file("google-services.json").asFile
val stagingGoogleServicesFile = layout.projectDirectory.file("src/staging/google-services.json").asFile

val validateProductionGoogleServices by tasks.registering {
    doLast {
        if (!productionGoogleServicesFile.isFile) {
            throw org.gradle.api.GradleException(
                "Missing app/google-services.json. Production Firebase/FCM builds must include this file."
            )
        }
    }
}

val validateStagingGoogleServices by tasks.registering {
    doLast {
        if (!stagingGoogleServicesFile.isFile) {
            throw org.gradle.api.GradleException(
                "Missing app/src/staging/google-services.json. Use only the isolated staging Firebase file."
            )
        }

        val root = JsonSlurper().parse(stagingGoogleServicesFile) as? Map<*, *>
            ?: throw org.gradle.api.GradleException("Invalid staging google-services.json.")
        val projectInfo = root["project_info"] as? Map<*, *>
            ?: throw org.gradle.api.GradleException("Missing staging Firebase project metadata.")
        if (projectInfo["project_id"] != "ia4tube-staging-checkpoint-a") {
            throw org.gradle.api.GradleException("Unexpected Firebase project for the staging variant.")
        }

        val clients = root["client"] as? List<*> ?: emptyList<Any>()
        val expectedClient = clients
            .mapNotNull { it as? Map<*, *> }
            .firstOrNull { client ->
                val clientInfo = client["client_info"] as? Map<*, *> ?: return@firstOrNull false
                val androidInfo = clientInfo["android_client_info"] as? Map<*, *>
                    ?: return@firstOrNull false
                androidInfo["package_name"] == "com.ia4tube.app.staging" &&
                    clientInfo["mobilesdk_app_id"] ==
                    "1:462270027427:android:e5b15e005d8e703c225116"
            }
        if (expectedClient == null || clients.size != 1) {
            throw org.gradle.api.GradleException("Unexpected Firebase Android app for the staging variant.")
        }
    }
}

tasks.matching { it.name == "preDebugBuild" || it.name == "preReleaseBuild" }.configureEach {
    dependsOn(validateProductionGoogleServices)
}
tasks.matching { it.name == "preStagingBuild" }.configureEach {
    dependsOn(validateStagingGoogleServices)
}
